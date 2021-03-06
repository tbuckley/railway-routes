var singularize = require('./inflection').singularize;

exports.Map = Map;

function Map(app, bridge) {
    if (!(this instanceof Map)) return new Map(app, bridge);
    this.app = app;
    this.bridge = bridge;
    this.paths = [];
    this.ns = '';
    // wtf???
    this.globPath = '/';
    this.pathTo = {};
    this.dump = [];
    this.middlewareStack = [];
}

Map.prototype.urlHelperName = function (path, action) {
    if (path instanceof RegExp) {
        path = path.toString().replace(/[^a-z]+/ig, '/');
    }

    // remove trailing slashes and split to parts
    path = path.replace(/^\/|\/$/g, '').split('/');

    // handle root paths
    if (path === '' || path === '/') return 'root';

    var helperName = [];
    path.forEach(function (token, index, all) {
        // skip variables
        if (token[0] == ':') return;

        var nextToken = all[index + 1] || '';
        // current token is last?
        if (index == all.length - 1) {
            token = token.replace(/\.:format\??$/, '');
            // same as action? - prepend
            if (token == action) {
                helperName.unshift(token);
                return;
            }
        }
        if (nextToken[0] == ':' || nextToken == 'new.:format?') {
            token = singularize(token);
        }
        helperName.push(token);
    });
    return helperName.join('_');
};

['get', 'post', 'put', 'delete', 'del', 'all'].forEach(function (method) {
    Map.prototype[method] = function (subpath, handler, middleware, options) {

        var controller, action;
        if (typeof handler === 'string') {
            controller = handler.split('#')[0];
            action = handler.split('#')[1];
        }

        var path;
        if (typeof subpath === 'string') {
            path = this.globPath + subpath.replace(/^\/|\/$/, '');
        } else { // regex???
            path = subpath;
        }

        // only accept functions in before filter when it's an array
        if (middleware instanceof Array) {
            var before_filter_functions = middleware.filter(function(filter) {
                return (typeof filter === 'function');
            });
            middleware = before_filter_functions.length > 0 ? before_filter_functions : null;
        }

        if (!(typeof middleware === 'function' || (middleware instanceof Array)) && typeof options === 'undefined') {
            options = middleware;
            middleware = null;
        }

        if (!options) {
            options = {};
        }

        path = options.collection ? path.replace(/\/:.*_id/, '') : path;

        var args = [path];
        if (middleware) {
            args = args.concat(this.middlewareStack.concat(middleware));
        }
        args = args.concat(this.bridge(this.ns, controller, action));

        this.dump.push({
            helper: options.as || this.urlHelperName(path, action),
            method: method,
            path: path,
            file: this.ns + controller,
            name: controller,
            action: action
        });

        this.addPath(path, action);

        this.app[method].apply(this.app, args);
    };
});

Map.prototype.addPath = function (templatePath, action) {
    if (templatePath instanceof RegExp) {
        // TODO: think about adding to `path_to` routes by reg ex
        return;
    }
    var paramsLength = templatePath.match(/\/:/g);
    paramsLength = paramsLength === null ? 0 : paramsLength.length;
    var helperName = this.urlHelperName(templatePath, action);

    // already defined? not need to redefine
    if (this.pathTo[helperName]) return;

    this.pathTo[helperName] = function () {
        if (arguments.length < paramsLength) {
            return '';
            // throw new Error('Expected at least ' + paramsLength + ' params for build path ' + templatePath + ' but only ' + arguments.length + ' passed');
        }
        var value, arg, path = templatePath;
        for (var i = 0; i < paramsLength; i += 1) {
            value = null;
            arg = arguments[i];
            if (arg && typeof arg.to_param == 'function') {
                value = arg.to_param();
            } else if (arg && arg.id) {
                value = arg.id;
            } else {
                value = arg;
            }
            path = path.replace(/:\w*/, value);
        }
        if (arguments[paramsLength]) {
            var query = [];
            for (var key in arguments[paramsLength]) {
                if (key == 'format' && path.match(/\.:format\??$/)) {
                    path = path.replace(/\.:format\??$/, '.' + arguments[paramsLength][key]);
                } else {
                    query.push(key + '=' + arguments[paramsLength][key]);
                }
            }
            if (query.length) {
                path += '?' + query.join('&');
            }
        }
        path = path.replace(/\.:format\?/, '');
        // add ability to hook url handling via app
        if (this.app.hooks && this.app.hooks.path) {
            this.app.hooks.path.forEach(function (hook) {
                path = hook(path);
            });
        }
        return path;
    }.bind(this);
    this.pathTo[helperName].toString = function () {
        return this.pathTo[helperName]();
    }.bind(this);
}

Map.prototype.resources = function (name, params, actions) {
    var self = this;
    // params are optional
    params = params || {};
    // if params arg omitted, second arg may be `actions`
    if (typeof params == 'function') {
        actions = params;
        params = {};
    }
    // we have bunch of actions here, will create routes for them
    var activeRoutes = getActiveRoutes(params);
    // but first, create subroutes
    if (typeof actions == 'function') {
        this.subroutes(name + '/:' + (singularize(name) || name) + '_id', actions);
    }
    // now let's walk through action routes
    for (var action in activeRoutes) {
        (function (action) {
            var route = activeRoutes[action].split(/\s+/);
            var method = route[0];
            var path = route[1];

            // append format
            if (path == '/') {
                path = '.:format?';
            } else {
                path += '.:format?';
            }

            // middleware logic (backward compatibility)
            var middlewareExcept = params.middlewareExcept, skipMiddleware = false;
            if (middlewareExcept) {
                if (typeof middlewareExcept == 'string') {
                    middlewareExcept = [middlewareExcept];
                }
                middlewareExcept.forEach(function (a) {
                    if (a == action) {
                        skipMiddleware = true;
                    }
                });
            }

            // params.path setting allows to override common path component
            var effectivePath = (params.path || name) + path;

            // and call map.{get|post|update|delete}
            // with the path, controller, middleware and options
            this[method.toLowerCase()].call(
                this,
                effectivePath,
                name + '#' + action,
                skipMiddleware ? [] : params.middleware,
                getParams(action, params)
            );
        }.bind(this))(action);
    }

    // calculate set of routes based on params.only and params.except
    function getActiveRoutes(params) {
        var activeRoutes = {},
            availableRoutes =
            {   'index':   'GET     /'
            ,   'create':  'POST    /'
            ,   'new':     'GET     /new'
            ,   'edit':    'GET     /:id/edit'
            ,   'destroy': 'DELETE  /:id'
            ,   'update':  'PUT     /:id'
            ,   'show':    'GET     /:id'
            };

        // 1. only
        if (params.only) {
            if (typeof params.only == 'string') {
                params.only = [params.only];
            }
            params.only.forEach(function (action) {
                if (action in availableRoutes) {
                    activeRoutes[action] = availableRoutes[action];
                }
            });
        }
        // 2. except
        else if (params.except) {
            if (typeof params.except == 'string') {
                params.except = [params.except];
            }
            for (var action in availableRoutes) {
                if (params.except.indexOf(action) == -1) {
                    activeRoutes[action] = availableRoutes[action];
                }
            }
        }
        // 3. all
        else {
            for (var action in availableRoutes) {
                activeRoutes[action] = availableRoutes[action];
            }
        }
        return activeRoutes;
    }

    function getParams(action, params) {
        var p = {};
        var plural = action === 'index' || action === 'create';
        if (params.as) {
            p.as = plural ? params.as : singularize(params.as);
            p.as = self.urlHelperName(self.globPath + p.as);
            if (action === 'new' || action === 'edit') {
                p.as = action + '_' + p.as;
            }
        }
        if (params.path && !p.as) {
            var aname = plural ? name : singularize(name);
            aname = self.urlHelperName(self.globPath + aname);
            p.as = action === 'new' || action === 'edit' ? action + '_' + aname : aname;
        }
        return p;
    }
};

Map.prototype.namespace = function (name, options, subroutes) {
    if (typeof options === 'function') {
        subroutes = options;
        options = null;
    }
    if (options && typeof options.middleware === 'function') {
        options.middleware = [options.middleware];
    }
    // store previous ns
    var old_ns = this.ns, oldGlobPath = this.globPath;
    // add new ns to old (ensure tail slash present)
    this.ns = old_ns + name.replace(/\/$/, '') + '/';
    this.globPath = oldGlobPath + name.replace(/\/$/, '') + '/';
    if (options && options.middleware) {
        this.middlewareStack = this.middlewareStack.concat(options.middleware);
    }
    subroutes(this);
    if (options && options.middleware) {
        options.middleware.forEach([].pop.bind(this.middlewareStack));
    }
    this.ns = old_ns;
    this.globPath = oldGlobPath;
};

Map.prototype.subroutes = function (name, subroutes) {
    // store previous ns
    var oldGlobPath = this.globPath;
    // add new ns to old (ensure tail slash present)
    this.globPath = oldGlobPath + name.replace(/\/$/, '') + '/';
    subroutes(this);
    this.globPath = oldGlobPath;
};

Map.prototype.addRoutes = function (path) {
    var routes = require(path);
    routes = routes.routes || routes;
    if (typeof routes !== 'function') {
        throw new Error('Routes is not defined in ' + path);
    }
    return routes(this);
};

