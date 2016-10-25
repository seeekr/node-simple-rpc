const net = require('net');
const debugServer = require('debug')('node-simple-rpc:rpcServer');
const debugClient = require('debug')('node-simple-rpc:rpcClient');
const queue = require('node-callback-queue');

const SYM_HOST = Symbol("host");
const SYM_PORT = Symbol("port");
const SYM_CLIENT = Symbol("client");
const SYM_AUTH = Symbol("auth");
const SYM_METHODS = Symbol("methods");
const SYM_MIDDLEWARES = Symbol("middlewares");


function noop() {

}

const TYPE_STRING = 0;
const TYPE_STRING_EMPTY = 1;
const TYPE_OBJECT = 2;
const TYPE_OBJECT_EMPTY = 3;
const TYPE_ARRAY = 4;
const TYPE_ARRAY_EMPTY = 5;
const TYPE_NULL = 6;
const TYPE_UNDEFINED = 7;
const TYPE_BOOLEAN_TRUE = 8;
const TYPE_BOOLEAN_FALSE = 9;
const TYPE_ZERO = 10;
const TYPE_NAN = 11;
const TYPE_INFINITY_P = 12;
const TYPE_INFINITY_N = 13;

const TYPE_INT8 = 14;
const TYPE_UINT8 = 15;
const TYPE_INT16 = 16;
const TYPE_UINT16 = 17;
const TYPE_INT32 = 18;
const TYPE_UINT32 = 19;
const TYPE_INT64 = 20;
const TYPE_UINT64 = 21;
const TYPE_FLOAT = 22;
const TYPE_DOUBLE = 23;

const TYPE_ERROR = 24;

const INTEGER_TYPES = {
    TYPE_INT8,
    TYPE_UINT8,
    TYPE_INT16,
    TYPE_UINT16,
    TYPE_INT32,
    TYPE_UINT32,
    TYPE_INT64,
    TYPE_UINT64
};

const NUMBER_READERS = {
    [TYPE_INT8]: [1, 'readInt8'],
    [TYPE_UINT8]: [1, 'readUInt8'],
    [TYPE_INT16]: [2, 'readInt16BE'],
    [TYPE_UINT16]: [2, 'readUInt16BE'],
    [TYPE_INT32]: [4, 'readInt32BE'],
    [TYPE_UINT32]: [4, 'readUInt32BE'],
    [TYPE_INT64]: [8, 'readInt64BE'],
    [TYPE_UINT64]: [8, 'readUInt64BE'],
    [TYPE_FLOAT]: [4, 'readFloatBE'],
    [TYPE_DOUBLE]: [8, 'readDoubleBE']
};

class Field {

    static deserialize(buffer, offset, done) {
        queue(
            Array.prototype.slice.call(arguments, 3),

            done,

            function (next) {
                Field.checkLength(buffer, offset, 1, next);
            },

            function (length, offset, next) {
                next(null, buffer.readUInt8(offset), offset + 1);
            },

            function (type, offset, next) {
                switch (type) {
                    case TYPE_ARRAY_EMPTY:
                        return next(null, [], offset);
                    case TYPE_ARRAY:
                        return Field.readArray(buffer, offset, next);

                    case TYPE_BOOLEAN_FALSE:
                        return next(null, false, offset);
                    case TYPE_BOOLEAN_TRUE:
                        return next(null, true, offset);

                    case TYPE_ERROR:
                        return Field.readObject(buffer, offset, function (err, obj, offset) {
                            if (err) return next(err);
                            obj = obj || {message: 'Unknown error'};
                            var error = new Error(obj.message, obj.id);
                            next(null, error, offset);
                        });

                    case TYPE_INFINITY_N:
                        return next(null, Number.NEGATIVE_INFINITY, offset);

                    case TYPE_INFINITY_P:
                        return next(null, Number.POSITIVE_INFINITY, offset);

                    case TYPE_NAN:
                        return next(null, Number.NaN, offset);

                    case TYPE_NULL:
                        return next(null, null, offset);

                    case TYPE_OBJECT_EMPTY:
                        return next(null, {}, offset);

                    case TYPE_OBJECT:
                        return Field.readObject(buffer, offset, next);

                    case TYPE_STRING_EMPTY:
                        return next(null, "", offset);
                    case TYPE_STRING:
                        return Field.readString(buffer, offset, next);

                    case TYPE_UNDEFINED:
                        return next(null, void 0, offset);

                    case TYPE_ZERO:
                        return next(null, 0, offset);

                    default:
                        if (NUMBER_READERS.hasOwnProperty(type)) {
                            var numberReader = NUMBER_READERS[type];
                            return queue(
                                next,

                                function (next) {
                                    Field.checkLength(buffer, offset, numberReader[0], next);
                                },

                                function (length, offset, next) {
                                    next(null, buffer[numberReader[1]](offset), offset + numberReader[0]);
                                }
                            )
                        }
                        break;
                }

                next(new Error("Unsupported Type!"));
            }
        );
    }

    static checkLength(buffer, offset, length, done) {
        done(offset + length > buffer.length ? new Error('EOF') : null, length, offset);
    }

    static readNumeric(buffer, offset, done) {
        Field.deserialize(buffer, offset, function (err, result, offset) {
            if (err) return done(err);
            if (isNaN(result = Number(result))) {
                return done(new Error("Expected number"));
            }
            return done(null, result, offset);
        });
    }

    static readInteger(buffer, offset, done) {
        Field.readNumeric(buffer, offset, function (err, result, offset) {
            if (err) return done(err);
            if (result !== Math.floor(result)) {
                return done(new Error("Expected integer"));
            }
            return done(null, result, offset);
        });
    }

    static readLength(buffer, offset, done) {
        Field.readInteger(buffer, offset, function (err, result, offset) {
            if (err) return done(err);
            if (result < 0) return done(new Error("Expected positive integer"));
            return done(null, result, offset);
        });
    }

    static readString(buffer, offset, done) {
        queue
        (
            done,

            function (next) {
                Field.readLength(buffer, offset, next);
            },

            function (len, offset, next) {
                next(null, buffer.toString('utf8', offset, offset += len), offset);
            }
        )
    }

    static readArray(buffer, offset, done) {
        queue
        (
            done,

            function (next) {
                Field.readLength(buffer, offset, next);
            },

            function (len, offset, next) {

                var cb = [
                    next,
                    function (next) {
                        Field.deserialize(buffer, offset, next);
                    }
                ];

                var data = [];

                for (var i = 0; i < len - 1; i++) {
                    cb.push(function (result, offset, next) {
                        data.push(result);
                        Field.deserialize(buffer, offset, next);
                    })
                }

                cb.push(function (result, offset, next) {
                    data.push(result);
                    next(null, data, offset);
                });

                queue.apply(null, cb);
            }
        )
    }

    static readObject(buffer, offset, done) {
        queue
        (
            done,

            function (next) {
                Field.readLength(buffer, offset, next);
            },

            function (len, offset, next) {

                var cb = [
                    next,
                    function (next) {
                        Field.deserialize(buffer, offset, next);
                    },
                    function (key, offset, next) {
                        Field.deserialize(buffer, offset, next, key);
                    }
                ];

                var data = {};

                for (var i = 0; i < len - 1; i++) {
                    cb.push(function (key, value, offset, next) {
                        data[key] = value;
                        Field.deserialize(buffer, offset, next);
                    }, function (key, offset, next) {
                        Field.deserialize(buffer, offset, next, key);
                    })
                }

                cb.push(function (key, value, offset, next) {
                    data[key] = value;
                    next(null, data, offset);
                });

                queue.apply(null, cb);
            }
        )
    }


    static serialize(stream, value, done) {
        switch (typeof value) {
            case 'undefined':
                return Field.writeType(stream, TYPE_UNDEFINED, done);
            case 'string':
                return Field.writeString(stream, value, done);
            case 'object':
                if (Array.isArray(value)) {
                    return Field.writeArray(stream, value, done);
                }
                return Field.writeObject(stream, value, done);
            case 'boolean':
                return Field.writeBoolean(stream, value, done);
            case 'number':
                return Field.writeNumber(stream, value, done);
        }
        throw new Error('Unsuppoerted type');
    }

    static writeType(stream, type, done) {
        var typeBuffer = new Buffer(1);
        typeBuffer.writeUInt8(type);
        stream.write(typeBuffer, done);
    }

    static writeString(stream, value, done) {

        if (!value.length) {
            return Field.writeType(stream, TYPE_STRING_EMPTY, done);
        }

        var strBuffer = new Buffer(value, 'utf8');

        queue(
            done,

            function (next) {
                Field.writeType(stream, TYPE_STRING, next);
            },

            function (next) {
                Field.serialize(stream, strBuffer.length, next);
            },

            function (next) {
                stream.write(strBuffer, next);
            }
        );
    }

    static writeObject(stream, value, done) {

        if (value === null) {
            return Field.writeType(stream, TYPE_NULL, done);
        }

        var type = TYPE_OBJECT;

        if (value instanceof Error) {
            type = TYPE_ERROR;
            value = {
                message: value.message,
                id: value.id
            };
        }

        var keys = Object.keys(value);

        if (!keys.length) {
            return Field.writeType(stream, TYPE_OBJECT_EMPTY, done);
        }

        queue
        (
            done,
            function (next) {
                Field.writeType(stream, type, next);
            },
            function (next) {
                Field.serialize(stream, keys.length, next);
            },
            function (next) {
                var cbs = [next];

                keys.forEach(function (key) {
                    var current = value[key];
                    cbs.push(function (nextOp) {
                        Field.serialize(stream, key, nextOp);
                    }, function (nextOp) {
                        Field.serialize(stream, current, nextOp);
                    });
                });

                queue.apply(null, cbs);
            }
        );
    }

    static writeArray(stream, value, done) {

        if (!value.length) {
            return Field.writeType(stream, TYPE_ARRAY_EMPTY, done);
        }

        queue
        (
            done,
            function (next) {
                Field.writeType(stream, TYPE_ARRAY, next);
            },
            function (next) {
                Field.serialize(stream, value.length, next);
            },
            function (next) {
                var cbs = value.map(function (item) {
                    return function (nextItem) {
                        Field.serialize(stream, item, nextItem);
                    };
                });
                cbs.unshift(next);
                queue.apply(null, cbs);
            }
        );
    }

    static writeBoolean(stream, value, done) {
        Field.writeType(stream, value ? TYPE_BOOLEAN_TRUE : TYPE_BOOLEAN_FALSE, done);
    }

    static writeNumber(stream, value, done) {

        switch (value) {
            case Number.NaN:
                return Field.writeType(stream, TYPE_NAN, done);
            case Number.POSITIVE_INFINITY:
                return Field.writeType(stream, TYPE_INFINITY_P, done);
            case Number.NEGATIVE_INFINITY:
                return Field.writeType(stream, TYPE_INFINITY_N, done);
            case 0:
                return Field.writeType(stream, TYPE_ZERO, done);
        }

        if (value === Math.floor(value)) {
            var bits = Math.floor(Math.log2(Math.abs(value)) + 1);

            if (value < 0) {
                bits++;
            }

            if (bits <= 8) bits = 8;
            else if (bits <= 16) bits = 16;
            else if (bits <= 32) bits = 32;
            else bits = 64;

            var method = 'write' + (value < 0 ? 'Int' : 'UInt') + bits + (bits > 8 ? 'BE' : '');
            var type = INTEGER_TYPES['TYPE_' + (value < 0 ? 'INT' : 'UINT') + bits];

            return queue
            (
                done,
                function (next) {
                    Field.writeType(stream, type, next);
                },
                function (next) {
                    var buffer = new Buffer(bits / 8);
                    buffer[method](value, 0);
                    stream.write(buffer, next);
                }
            );
        }

        if (value >= 3.402823e38 && value <= 3.40282347E+38) {
            return queue
            (
                done,
                function (next) {
                    Field.writeType(stream, TYPE_FLOAT, next);
                },
                function (next) {
                    var buffer = new Buffer(4);
                    buffer.writeFloatBE(value, 0);
                    stream.write(buffer, next);
                }
            );
        }

        queue
        (
            done,
            function (next) {
                Field.writeType(stream, TYPE_DOUBLE, next);
            },
            function (next) {
                var buffer = new Buffer(8);
                buffer.writeDoubleBE(value, 0);
                stream.write(buffer, next);
            }
        );
    }
}

class Message {

    eachKey(cb) {
        throw new Error("Abstract!");
    }

    hasKey() {
        throw new Error("Abstract!");
    }

    peekKey() {
        throw new Error("Abstract!");
    }

    shiftKey() {
        throw new Error("Abstract!")
    }

    onKeyFail(key, err, cb) {
        throw new Error("Abstract!");
    }

    onKeyReady(key, error, cb) {
        throw new Error("Abstract!");
    }

    onComplete(cb) {
        throw new Error("Abstract!");
    }

    get data() {
        throw new Error("Abstract!");
    }

    parse(cb) {

        if (!this.hasKey()) {
            return this.onComplete(cb);
        }

        if (!this.buffer || !this.buffer.length) {
            return;
        }

        var currentKey = this.peekKey();

        Field.deserialize(this.buffer, 0, function (err, result, offset) {
            if (err) {
                if (err.message === "EOF") {
                    return;
                }
                return this.onKeyFail(currentKey, err, cb);
            }
            this.buffer = this.buffer.slice(offset);
            this.data[currentKey] = result;
            this.onKeyReady(this.shiftKey(), result, function (err) {
                if (err) return cb(err);
                this.parse(cb);
            }.bind(this));

        }.bind(this));
    }

    process(buffer, cb) {

        if (!Buffer.isBuffer(buffer)) {
            return cb(new Error("Invalid input"));
        }

        if (!this.buffer) {
            this.buffer = buffer;
        } else {
            this.buffer = Buffer.concat([this.buffer, buffer]);
        }

        this.parse(cb);
    }

    serialize(stream, done) {
        var cb = [done];
        var data = this.data;
        this.eachKey(function (key) {
            cb.push((function (stream, value) {
                return function (next) {
                    Field.serialize(stream, value, next);
                };
            })(stream, data[key]));
        });
        queue.apply(null, cb);
        return this;
    }
}

class Input extends Message {

    constructor(data = void 0, authCallback = void 0) {
        super();
        this._keys = ['auth', 'name', 'args'];
        this._data = data || {};
        this._authCallback = authCallback;
    }

    eachKey(cb) {
        this._keys.forEach(cb);
    }

    hasKey() {
        return this._keys.length;
    }

    peekKey() {
        return this._keys[0];
    }

    shiftKey() {
        return this._keys.shift();
    }

    onKeyFail(key, err, cb) {
        cb(new Error("Invalid Parameter. " + key + '=' + err.message));
    }

    onKeyReady(key, value, cb) {
        if (key === 'auth') {
            if (this._authCallback) {
                return this._authCallback(value, cb);
            }
        }
        cb();
    }

    onComplete(cb) {
        cb(null, this.data);
    }

    get data() {
        return this._data;
    }
}

class Output extends Message {

    constructor(data = void 0) {
        super();
        this._keys = ['error', 'result'];
        this._data = data || {};
    }

    eachKey(cb) {
        this._keys.forEach(cb);
    }

    hasKey() {
        return this._keys.length;
    }

    peekKey() {
        return this._keys[0];
    }

    shiftKey() {
        return this._keys.shift();
    }

    onKeyFail(key, err, cb) {
        cb(new Error("Invalid Parameter. " + key + '=' + err.message));
    }

    onKeyReady(key, value, cb) {
        cb();
    }

    onComplete(cb) {
        cb(null, this.data);
    }

    get data() {
        return this._data;
    }
}

class HostPortAuth {

    constructor(host, port, auth) {
        this[SYM_HOST] = host;
        this[SYM_PORT] = port;
        this[SYM_AUTH] = auth;
    }

    get host() {
        return this[SYM_HOST];
    }

    get port() {
        return this[SYM_PORT];
    }

    get auth() {
        return this[SYM_AUTH];
    }
}

class Socket extends HostPortAuth {

    constructor(host, port, auth) {
        super(host, port, auth);
    }

    get client() {
        return this[SYM_CLIENT];
    }
}

class Server extends Socket {

    constructor(host, port, auth) {
        super(host, port, auth);
        this[SYM_METHODS] = {};
        this[SYM_MIDDLEWARES] = [];
    }

    get exports() {
        return this[SYM_METHODS];
    }

    set exports(value) {
        this[SYM_METHODS] = value || {};
    }

    get middlewares() {
        return this[SYM_MIDDLEWARES];
    }

    start() {
        let {client} = this;
        if (!client) {
            this[SYM_CLIENT] = client =
                net.createServer((c) => {

                    debugServer("Client connected %s:%s", c.remoteAddress, c.remotePort);

                    c.setNoDelay(true);
                    c.message = new Input({}, (auth, cb) => {
                        debugServer("Client authentication %s:%s", c.remoteAddress, c.remotePort);
                        c.auth = auth;

                        var middlewares = this.middlewares;
                        if (!middlewares.length) {
                            if (auth !== this.auth) {
                                return cb(new Error("Unauthorized"));
                            }
                            return cb();
                        }

                        var args = [cb];
                        middlewares.forEach(middleware => {
                            args.push(function (next) {
                                middleware(c, next);
                            })
                        });
                        queue.apply(null, args);
                    });

                    c.on('data', (data) => {
                        c.message.process(data, (err, msg) => {
                            debugServer("Processing message %s:%s", c.remoteAddress, c.remotePort);
                            if (err) {
                                return c.emit('error', err);
                            }

                            var method = this.exports[msg.name];
                            if (typeof method !== 'function') {
                                return c.emit('error', new Error('Unknown method: ' + msg.name));
                            }

                            var args = msg.args.slice();
                            args.push(c, function (err) {

                                if (err) {
                                    return c.emit('error', err);
                                }

                                debugServer("Sending results to %s:%s", c.remoteAddress, c.remotePort);
                                var result = Array.prototype.slice.call(arguments, 1);
                                var output = new Output({result});
                                output.serialize(c, function (err) {
                                    if (err) {
                                        return c.emit('error', err);
                                    }
                                    debugServer("Results sent to %s:%s", c.remoteAddress, c.remotePort);
                                    c.destroy();
                                });
                            });

                            debugServer("Calling server method '%s' for %s:%s", msg.name, c.remoteAddress, c.remotePort);
                            method.apply(null, args);
                        });
                    });

                    c.on('close', function (hadError) {
                        debugServer('Client disconnected %s:%s, hadError=%s', c.remoteAddress, c.remotePort, hadError);
                    });

                    c.on('error', function (err) {
                        debugServer("Client error: %s:%s, %s", c.remoteAddress, c.remotePort, err);
                        if (c.writable) {
                            var output = new Output({error: err});
                            return output.serialize(c, function () {
                                c.destroy();
                            });
                        }
                        c.destroy();
                    });
                });
            client.on('listening', () => {
                var addr = client.address();
                debugServer('Server is listening on %s:%s', addr.address, addr.port);
            });
        }
        if (client.listening) return;
        client.listen(this.port, this.host);
    }

    stop() {
        let {client} = this;
        if (!client) return;
        client.destroy();
        delete this[SYM_CLIENT];
    }

    use(cb) {
        if (typeof cb !== 'function') {
            return;
        }

        let {middlewares} = this;
        if (middlewares.indexOf(cb) > -1) return;
        middlewares.push(cb);
        return this;
    }
}

class Channel extends Socket {
    constructor(host, port, auth) {
        super(host, port, auth);
    }

    exec(name, args, cb) {
        let {client} = this;
        if (client) return;

        this[SYM_CLIENT] = client = new net.Socket();
        client.setNoDelay(true);

        let {host, port, auth} = this;

        client.on('close', (hadError) => {
            debugClient('Disconnected from %s:%s, hadError=%s', client.remoteAddress, client.remotePort, hadError);
        });

        client.on('data', (data) => {
            var output = new Output({});
            output.process(data, function (err, message) {
                if (err) {
                    return client.emit('error', err);
                }

                if (message.error) {
                    return client.emit('error', message.error);
                }

                var result = message.result;
                if (!Array.isArray(result)) {
                    result = [result];
                }

                result.push(client);

                result.unshift(null);

                cb.apply(null, result);
                debugClient("RPC request completed successfully on %s:%s", client.remoteAddress, client.remotePort);
            });
        });

        client.on('error', (err) => {
            debugClient('RPC Request failed on %s:%s with %s', client.remoteAddress, client.remotePort, err);
            cb(err);
        });

        client.connect({
            host,
            port
        }, () => {

            debugClient('Connected to %s:%s', client.remoteAddress, client.remotePort);
            debugClient('Calling remote procedure "%s(%s)" on %s:%s', name, args.map(arg => JSON.stringify(arg)).join(', '), client.remoteAddress, client.remotePort);

            client.input =
                new Input({
                    auth,
                    name,
                    args
                }).serialize(client, function (err) {
                    if (err) {
                        debugClient("RPC request failed on %s:%s with %s", client.remoteAddress, client.remotePort, err);
                        return client.destroy(err);
                    }

                    debugClient("RPC request sent successfully to %s:%s.", client.remoteAddress, client.remotePort);
                });
        })
    }
}

class Client extends HostPortAuth {

    constructor(host, port, auth) {
        super(host, port, auth);
    }

    rpc(name, args, cb) {
        var channel = new Channel(this.host, this.port, this.auth);
        channel.exec(name, args || [], cb || noop);
        return channel;
    }
}

module.exports = {

    server: function (options) {
        return new Server(options.host || '0.0.0.0', options.port, options.auth);
    },

    client: function (options) {
        return new Proxy(new Client(options.host || 'localhost', options.port, options.auth), {
            get: function (target, prop) {
                if (prop in target) {
                    return target[prop];
                }
                return function () {
                    var args = Array.prototype.slice.call(arguments);
                    if (!args.length || typeof args[args.length - 1] !== 'function') {
                        args.push(noop);
                    }
                    var cb = args.pop();
                    args = [prop, args, cb];
                    target.rpc.apply(target, args);
                };
            }
        });
    }
};