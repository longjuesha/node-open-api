"use strict";
let restify = require('restify'), restifyErrors = require('restify-errors'),
    _ = require('lodash'), services = {}, hooks = {};

let restServer = function(core, options, end) {
  services = options.services || {};
  let config = options.config || {};
  let resultJson = {};
  let codes = {
    FAILED: config.custom_failed_code || -1,
    ERROR: config.custom_error_code || 0,
    SUCCESS: config.custom_success_code ||  1
  };
  let logger = core.getLogger('node-open-api');
  // start restify server
  let server = restify.createServer({
    name: config.name || 'Handsome Restful API Server',
    version: config.version || '1.0.0'
  });
  server.use(restify.plugins.queryParser({ mapParams: false }));
  server.use(restify.plugins.bodyParser({ maxFieldsSize: 10485760, mapParams: false }));
  server.use(restify.plugins.gzipResponse());
  server.on('error', core.getErrorHandler());
  server.on('UnsupportedMediaType', (req, res) => {
    resultJson = {};
    _.get(config, 'custom_code.enable', true) && (resultJson[_.get(config, 'custom_code.name', 'code')] = codes.FAILED);
    _.get(config, 'custom_message.enable', true) && (resultJson[_.get(config, 'custom_message.name', 'message')] = 'Request format is wrong');
    res.send(400, resultJson);
  });
  let funcNotFound = (req, res) => {
    resultJson = {};
    _.get(config, 'custom_code.enable', true) && (resultJson[_.get(config, 'custom_code.name', 'code')] = codes.FAILED);
    _.get(config, 'custom_message.enable', true) && (resultJson[_.get(config, 'custom_message.name', 'message')] =  'Method not found');
    res.send(404, resultJson);
  };
  server.on('NotFound', funcNotFound);
  server.on('MethodNotAllowed',funcNotFound);
  server.on('VersionNotAllowed', funcNotFound);
  server.on('NotAuthorized', (req, res) => {
    resultJson = {};
    _.get(config, 'custom_code.enable', true) && (resultJson[_.get(config, 'custom_code.name', 'code')] = codes.FAILED);
    _.get(config, 'custom_message.enable', true) && (resultJson[_.get(config, 'custom_message.name', 'message')] = 'Access denied');
    res.send(403, resultJson);
  });
  server.on('uncaughtException', (req, res, route, error) => {
    if (!res.headersSent) {
      resultJson = {};
      _.get(config, 'custom_code.enable', true) && (resultJson[_.get(config, 'custom_code.name', 'code')] = codes.ERROR);
      _.get(config, 'custom_message.enable', true) && (resultJson[_.get(config, 'custom_message.name', 'message')] = 'Error: ' + error);
      res.send(500, resultJson);
    }
  });
  server.pre((req, res, next) => {
    do {
      // check token
      if (config.token !== undefined) {
        let headers = req.headers;
        if (headers.token === undefined) {
          break;
        }
        if (_.isArray(config.token)) {
          // config is an array
          if (!_.includes(config.token, headers.token)) {
            break;
          }
        } else if (headers.token !== config.token) {
          // config is only one token
          break;
        }
      }
      // check remote ip
      if (config.ip_list && config.ip_list.length) {
        if (!_.includes(config.ip_list, req.socket.remoteAddress)) {
          break;
        }
      }
      return next();
    } while (0);
    return next(new restifyErrors.NotAuthorizedError());
  });
  // response callback
  let funcRespond = (req, res, next) => {
    let service = req.params.service, instance,
        method = req.method.toLowerCase() + '_' + (req.params.method || 'default');
    if (services[service] === undefined || ((instance = services[service]) &&
        typeof instance[method] !== 'function')) {
      return next(new restifyErrors.NotFoundError());
    }
    // output and next
    let funcNext = (result) => {
      if (config.custom_result) {
        res.send(200, result);
      } else {
        if (result === undefined) {
          res.send(200, { code: codes.SUCCESS });
        } else {
          res.send(200, { code: codes.SUCCESS, result: result });
        }
      }
      return next();
    };

    if (instance[method].length == 3) {
      // async callback
      instance[method](req, res, funcNext);
    } else {
      // sync
      funcNext(instance[method](req, res));
    }
  };
  server.get(':service', funcRespond);
  server.post(':service', funcRespond);
  server.put(':service', funcRespond);
  server.del(':service', funcRespond);
  server.get(':service/:method', funcRespond);
  server.post(':service/:method', funcRespond);
  server.put(':service/:method', funcRespond);
  server.del(':service/:method', funcRespond);
  // get server instance
  this.getServer = () => server;
  // close restify server
  this.close = () => {
    // uninit services
    _.forEach(services, (service) => {
      if (typeof service.uninit === 'function') {
        service.uninit();
      }
    });
    services = {};
    if (server) {
      server.close();
    }
  };
  // listen
  let funcRun = () => {
    server.listen(config.port || 1108, config.host || null, () => {
      logger.info('REST server started [' + process.pid + '], address: ' + server.url);
      if (typeof end === 'function') {
        end();
      }
    });
  };

  // start services
  this.getService = (service) => {
    return services[service] !== undefined ? services[service] : false;
  };
  // Invokes a hook in a particular service
  this.serviceInvoke = (serviceName, hook, args, callback) => {
    if (!this.serviceHook(service, hook)) {
      return false;
    }
    let m = core.getService(serviceName),
        c = hooks[hook][serviceName];
    m[c](args, callback);
  };
  // Invokes a hook in all services that implement it
  this.serviceInvokeAll = (hook, args, callback) => {
    _.forEach(this.serviceImplements(hook), (serviceName) => {
      let m = core.getService(serviceName),
          c = hooks[hook][serviceName];
      m[c](args, callback);
    });
  };
  // Determines whether a service implements a hook
  this.serviceHook = (service, hook) => {
    return hooks[hook] && hooks[hook][service];
  };
  // Determines which services are implementing a hook
  this.serviceImplements = (hook) => {
    return hooks[hook] ? _.keys(hooks[hook]) : [];
  };

  // init service
  core.forEach(services, (service, serviceName, next) => {
    let domainLoader = require('domain').create();
    domainLoader.on('error', (error) => {
      logger.fatal('Service [' + serviceName + '] load error');
      (core.getErrorHandler())(error, 'fatal');
    });
    domainLoader.run(() => {
       // hook defination
      if (typeof service.hooks === 'function') {
        _.forEach(service.hooks(), function(c, n) {
          if (!_.isString(c) || !_.isString(n)) {
            return;
          }
          if (typeof service[c] !== 'function') {
            return;
          }
          if (!hooks[n]) {
            hooks[n] = {};
          }
          hooks[n][serviceName] = c;
        });
      }
      if (typeof service.init === 'function') {
        if (service.init.length == 3) {
          // async callback
          return service.init(serviceName, core, (result) => {
            delete service.init;
            if (result === false) {
              throw '[' + serviceName +'] init fail';
            }
            next();
          });
        } else {
          // sync
          let result = service.init(serviceName, core);
          delete service.init;
          if (result === false) {
            throw '[' + serviceName +'] init fail';
          }
        }
      }
      next();
    });
  }, () => setImmediate(funcRun));
};

module.exports = (core, options, end) => {
  return new restServer(core, options, end);
};
