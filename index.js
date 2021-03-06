const EventEmitter = require('events');
const Mqtt = require('mqtt');
const mqttWildcard = require('mqtt-wildcard');
const shortid = require('shortid');

/*
  Todo: clarify: rename the lib. Could we call this Module "mqtt-smarthome-connection" on npm and keept the npm name
  "mqtt-smarthome" reserved for a possible future meta-package?
 */

class MqttSmarthome extends EventEmitter {
    /**
     *
     * @param {string} [mqttUrl=mqtt://localhost]
     * @param {object} [options] see all available options in the [MQTT.js docs](https://github.com/mqttjs/MQTT.js#client)
     * @param {object} [options.logger]
     * @param {string} [options.clientId=mqttsmarthome-<random>]
     */
    constructor(mqttUrl = 'mqtt://localhost', options = {}) {
        super();
        this.messageCallbacks = {};
        this.callbackIds = {};

        // Todo document which properties logger has to supply
        this.log = options.logger || {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {}
        };

        // Delete non-MQTT.js options (Todo clarify necessary?)
        delete options.logger;

        this.mqttUrl = mqttUrl;
        this.mqttOptions = Object.assign({
            clientId: 'mqttsmarthome-' + shortid.generate()
        }, options);

        // Todo clarify: is there a nicer way to create function aliases?
        /**
         * Just a convenience alias to [subscribe](#MqttSmarthome+subscribe)
         * @type {MqttSmarthome.subscribe}
         */
        this.sub = this.subscribe;

        /**
         * Just a convenience alias to [publish](#MqttSmarthome+publish)
         * @type {MqttSmarthome.publish}
         */
        this.pub = this.publish;

        /* Todo clarify if we should call connect on instanciatig. I think this would be a convenient behavior. Maybe
            configurable through a default true autoConnect option.
         */
    }

    /**
     *
     */
    connect() {
        // Todo clarify if we should stick to the MQTT.js way with mqsh - no need to use the new operator, connect()
        // returns a new instance, url and options are passed via the connect function. would make migration of existing
        // xy2mqtt easier and I think it's good to keep it as similar to MQTT.js as possible. @dersimn what do you think?
        this.mqtt = Mqtt.connect(this.mqttUrl, this.mqttOptions);

        this.mqtt.on('connect', () => {
            // Todo clarify: I'd like to stick to the event names of MQTT.js. Makes porting to mqtt-smarthome easier and
            // is just better ;) Ok for you @Simon?

            /**
             * @event MqttSmarthome#connected
             */
            this.emit('connected');
            this.log.debug('mqtt conencted', this.mqttUrl, this.clientId);
        });

        this.mqtt.on('close', () => {
            /**
             * @event MqttSmarthome#disconnected
             */
            this.emit('disconnected');
            this.log.debug('mqtt disconnected');
        });

        this.mqtt.on('error', err => {
            // Todo: clarify if we should emit this event - i think we should
            this.log.error('mqtt', err.toString());
        });

        this.mqtt.on('offline', () => {
            // Todo: clarify if we should emit this event - i think we should
            this.log.error('mqtt offline');
        });

        this.mqtt.on('reconnect', () => {
            // Todo: clarify if we should emit this event - i think we should
            this.log.info('mqtt reconnect');
        });

        this.mqtt.on('message', (topic, payload, packet) => {
            payload = this._parsePayload(payload);
            this.log.debug('mqtt <', topic, payload);

            /**
             * @event MqttSmarthome#message
             * @param {string} topic
             * @param {string} payload
             * @param {Mqtt.packet} packet Todo add link to MQTT.js docs
             */
            this.emit('message', topic, payload, packet);

            Object.keys(this.messageCallbacks).forEach(callbackTopic => {
                if (mqttWildcard(topic, callbackTopic) && this.messageCallbacks[callbackTopic]) {
                    Object.keys(this.messageCallbacks[callbackTopic]).forEach(id => {
                        if (typeof this.messageCallbacks[callbackTopic][id] === 'function') {
                            // Todo clarify (optional) topic shortening (replace +/status/# with +//#)
                            // @simon let us chat or phone, then i can explain the thought behind that

                            /**
                             * @callback {function} messageCallback
                             * @param {string} topic
                             * @param {string|number|boolean|object} payload
                             * @param {Mqtt.packet} packet
                             */
                            this.messageCallbacks[callbackTopic][id](topic, payload, packet);
                        }
                    });
                }
            });
        });
    }

    /**
     * Disconnect from the MQTT broker.
     * @param {boolean} [force=false] passing it to true will close the client right away, without waiting for the in-flight messages to be acked.
     * @param {function} [callback] will be called when the client is closed.
     */
    end(force, callback) {
        this.mqtt.end(force, callback);
    }

    _parsePayload(payload) {
        /* Todo clarify what to do with Buffer (binary) payloads? Do we want to support them? I think we should.
            Solution: don't bother. The raw payload is available in packet.payload.
          */
        payload = payload.toString();

        /* Todo clarify extract this type-guessing stuff into an own function or even module or is this exaggerated? */
        if (payload.indexOf('{') !== -1) {
            try {
                payload = JSON.parse(payload);
            } catch (err) {
                this.log.error(err.toString());
            }
        } else if (payload === 'false') {
            payload = false;
        } else if (payload === 'true') {
            payload = true;
        } else if (!isNaN(payload)) {
            payload = parseFloat(payload);
        }
        return payload;
    }

    // Todo clarify: should we rename subscribe to "sub" and publish to "pub"? Just for convenience. I think it's
    // clearly enough and less to type ;) -> Easy solution: provide both, so we have short convinience method names
    // and long MQTT.js conform ones :-) See line 40

    /**
     *
     * @param {string} topic
     * @param {messageCallback} [callback=null]
     * @returns {idSubscription} id
     */
    subscribe(topic, callback = null) {
        // Todo clarify if we need callback default null. Wouldn't undefined be ok?
        /* Todo clarify if we should have the possiblity to set the QoS level. Will become difficult as there could be
            more than 1 subscriptions on the same topic with different callbacks. Solution could be to always subscribe
            with the highest callback. This would imply that we need to keep track of the current subscriptions QoS
            level, could be done in the callbackIds object, instead of saving the string topic we could save am object
            like {topic: 'the/topic/', qos: 2} and introduce a new cache that holds all IDs belonging to a specific
            topic. Subscribe would then have to check if the QoS Level needs to raised, unsubscribe would have to check
            if the QoS level needs to be lowered.
             @dersimn - what do you think? I only use level 0 as of today, but I think having the possibility to use
             higher levels would be good. */

        /* Todo clarify handle topics of type object or instance of array in speacial way. Mqtt.js does this:
        topic is a String topic to subscribe to or an Array of topics to subscribe to. It can also be an object,
        it has as object keys the topic name and as value the QoS, like {'test1': 0, 'test2': 1}.
        Looks nice to me but would generate a problem that has to be solved. Will the callback then be registered on all
        that topic? It has to i think. But how about unsubscribing then? reutrn an Array of subscription IDs? doable.
        @simon what do you think?
         */
        const id = shortid.generate();
        this.callbackIds[id] = topic;
        if (!this.messageCallbacks[topic]) {
            // First subscription on that topic
            this.messageCallbacks[topic] = {};
            // Todo check if topic is a non-empty string before subscribing;
            this.mqtt.subscribe(topic);
        }
        this.messageCallbacks[topic][id] = callback;

        return id;
    }

    /**
     * Unregister a callback. If no registered callback on the corresponding topic is left a MQTT unsubscribe will be
     * done.
     *
     * @param {idSubscription} id an id that was returned by the [subscribe()](#MqttSmarthome+subscribe) method.
     * @returns {number} remaining number of subscription on that topic
     */
    unsubscribe(id) {
        const topic = this.callbackIds[id];
        if (topic) {
            delete this.messageCallbacks[topic][id];
            const length = Object.keys(this.messageCallbacks[topic]).length;
            if (length === 0) {
                this.mqtt.unsubscribe(topic);
                delete this.messageCallbacks[topic];
            }
            return length;
        }
        return 0;
    }

    /**
     * Publish a MQTT message. Payloads that are neither of type `string` nor an instance of `Buffer` will be JSON
     * stringified.
     *
     * @param {string} topic
     * @param {*} payload
     * @param {object} [options]
     * @param {number} [options.qos=0] QoS level
     * @param {boolean} [options.retain=false] Retain Flag
     * @param {boolean} [options.dup=false] Mark as duplicate flag
     * @param {function} [callback] Fired when the QoS handling completes, or at the next tick if QoS 0. An error occurs if client is disconnecting.
     */
    publish(topic, payload, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        } else {
            options = options || {};
        }
        const type = typeof payload;
        if (type === 'object' && !(payload instanceof Buffer)) {
            payload = JSON.stringify(payload);
        } else if (type !== 'object') {
            payload = String(payload);
        }
        this.log.debug('mqtt >', topic, payload);
        // Todo check if topic is a non-empty string before calling mqtt.publish?
        this.mqtt.publish(topic, payload, options, callback);
    }

    /**
     * Publish multiple messages at once. Every property value of the object data is published as a distinct message.
     * The basetopic is appended by the properties name.
     * @param {string} basetopic
     * @param {object} data
     * @param {object} [options] see [publish](#MqttSmarthome+publish)
     * @example publishMulti('sun', {azimuth: 5, altitude: 0} // will publish 5 on the topic sun/azimuth and 0 on the topic sun/altitude.
     */
    publishMulti(basetopic, data, options) {
        // Todo clarify: Instead of having a separate piblishMulti function we could distinct that by the type of the
        // topic param. So if publish gets a topic of type object instead of string it knows that this should be a
        // multi-publish. The data param would get optional and has to be ommited on multi-publishing, it may only
        // exist if topic is single topic (string). @dersimn - what do think? Another Idea would be to handle topics of
        // type array in a special way too: they would need the data param and just publish the same data on all topics
        // contained in the topic-array.

        if (typeof data !== 'object') {
            return false;
        }
        Object.keys(data).forEach(topic => {
            this.publish(basetopic + '/' + topic, data[topic], options);
        });
    }

    /**
     * Publish a value on a MQTT-Smarthome +/set/# topi.
     * @param {string} topic
     * @param {*} val
     * @param {object} [options]
     * @param {function} [callback]
     */
    publishSet(topic, val, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        } else {
            options = options || {};
        }
        // Todo insert "set" as second topic level if undefined. E.g. "hm//Licht/STATE" becomes "hm/set/Licht/STATE"
        // Todo replace "$" by "var/set/". E.g. "$Automatik/Licht" becomes "var/set/Automatik/Licht"
        this.publish(topic, val, options, callback);
    }

    /**
     * Publish a value on a MQTT-SMart +/status/# topic
     * @param {string} topic
     * @param {*} val
     * @param {object} [options]
     * @param {function} [callback]
     */
    publishStatus(topic, val, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        } else {
            options = options || {};
        }
        /* Todo clarify if we also add the lc attribute here. Would mean we have to keep track of all published values.
        @dersimn this would be a good place to provide a time-to-live option and set the unpublish-timeout. what do you
        think? */
        // Todo insert "status" as second topic level if undefined. E.g. "hm//Licht/STATE" becomes "hm/status/Licht/STATE"
        // Todo replace "$" by "var/status/". E.g. "$Automatik/Licht" becomes "var/status/Automatik/Licht"
        const payload = {val, ts: (new Date().getTime())};

        if (typeof options.retain === 'undefined') {
            // Retain default true
            options.retain = true;
        }
        this.publish(topic, payload, options, callback);
    }
}

module.exports = MqttSmarthome;
