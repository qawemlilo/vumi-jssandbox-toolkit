// state_machine.js
//  - Interaction machine for messages and events.

var promise = require("./promise.js");
var Promise = promise.Promise;
var maybe_promise = promise.maybe_promise;
var success = promise.success;


function IMEvent(event, im, data) {

    var self = this;

    self.event = event; // event type
    self.im = im; // interaction machine
    self.data = data; // event data
}

function SessionNewEvent(im) {
    return new IMEvent('session_new', im, {});
}

function SessionCloseEvent(im, possible_timeout) {
    return new IMEvent('session_close', im,
                       {possible_timeout: possible_timeout});
}

function SessionResumeEvent(im) {
    return new IMEvent('session_resume', im, {});
}

function NewUserEvent(im, user_addr, user) {
    return new IMEvent('new_user', im, {user_addr: user_addr, user: user});
}

function StateEnterEvent(im, state) {
    return new IMEvent('state_enter', im, {state: state});
}

function StateExitEvent(im, state, user) {
    return new IMEvent('state_exit', im, {state:state});
}


function InteractionMachine(api, state_creator) {

    var self = this;

    self.api = api;
    self.state_creator = state_creator;

    self.user = null;
    self.user_addr = null;
    self.i18n = null;
    self.i18n_lang = null;
    self.current_state = null;
    self.config = null;
    self.metrics = null;

    self.set_user_lang = function(lang) {
        self.user.lang = lang;
    };

    self.set_user_answer = function(state_name, answer) {
        if (!self.user.answers) self.user.answers = {};
        self.user.answers[state_name] = answer;
    };

    self.get_user_answer = function(state_name) {
        if (!self.user.answers) return null;
        var answer = self.user.answers[state_name];
        return (typeof answer == 'undefined') ? null : answer;
    };

    self.set_user_state = function(state_name) {
        // this just sets the users state
        // actual state changes are handled by switch_state
        self.user.current_state = state_name;
    };

    self.attach = function() {
        self.api.on_unknown_command = self.on_unknown_command;
        self.api.on_inbound_message = self.on_inbound_message;
        self.api.on_inbound_event = self.on_inbound_event;
        self.api.im = self;
    };

    self.on_event = function(event) {
        return self.state_creator.on_event(event);
    };

    self.switch_state = function(state_name) {
        var p = new Promise();
        if (self.current_state && state_name == self.current_state.name) {
            p.callback();
            return p;
        }
        var old_state_name = (self.current_state ? self.current_state.name :
                              self.user.current_state);
        p.add_callback(self.refresh_i18n);
        p.add_callback(function () {
            return self.state_creator.switch_state(state_name, self);
        });
        p.add_callback(function (new_state) {
            var ev_p;
            if (self.current_state) {
                ev_p = self.on_event(new StateExitEvent(self,
                                                        self.current_state));
            } else {
                ev_p = success();
            }
            var on_exit = (self.current_state ?
                           self.current_state.on_exit :
                           function () {});
            var on_enter = (old_state_name != new_state.name ?
                            new_state.on_enter :
                            function () {});
            ev_p.add_callback(function () {
                return maybe_promise(on_exit());
            });
            ev_p.add_callback(function () {
                self.current_state = new_state;
                self.user.current_state = new_state.name;
                return self.on_event(new StateEnterEvent(self, new_state));
            });
            ev_p.add_callback(function() {
                return maybe_promise(new_state.setup_state(self));
            });
            ev_p.add_callback(function() {
                return maybe_promise(on_enter());
            });
        });
        p.callback();
        return p;
    };

    self.refresh_i18n = function() {
        var p = new Promise();
        if (!self.user.lang) {
            self.i18n_lang = null;
            self.i18n = new jed({});
            p.callback();
            return p;
        }
        if ((!self.i18n) || (self.user.lang != self.i18n_lang)) {
            self.fetch_translation(self.user.lang, function (i18n) {
                self.i18n_lang = self.user.lang;
                self.i18n = i18n;
                p.callback();
            });
            return p;
        }
        p.callback(); // cached case
        return p;
    };

    self.fetch_config_value = function(key, json, done) {
        self.api.request("config.get", {key: key},
            function(reply) {
                var value = null;
                if (reply.value && json) {
                    try { value = JSON.parse(reply.value); }
                    catch (e) {}
                }
                else {
                    value = reply.value;
                }
                done(value);
            });
    };

    self.fetch_translation = function(lang, done) {
        self.fetch_config_value("translation." + lang, true,
            function(domain_data) {
                var jed_data = {};
                if (domain_data) {
                    jed_data.domain = "messages";
                    jed_data.locale_data = {"messages": domain_data};
                }
                var i18n = new jed(jed_data);
                done(i18n);
            });
    };

    self.setup_config = function() {
        var p = new Promise();
        self.fetch_config_value("config", true,
            function (config) {
                self.config = config || {};
                p.callback();
            });
        return p;
    };

    self.setup_metrics = function() {
        var store = self.config.metric_store || 'default';
        self.metrics = new MetricStore(self.api, store);
    };

    self.load_user = function(from_addr, done) {
        var p = new Promise();
        self.user_addr = from_addr;
        self.api.request("kv.get",
            {key: "users." + from_addr},
            function(reply) {
                self.user = reply.value || {};
                if (!reply.value) {
                    p.add_callback(function () {
                        return self.on_event(new NewUserEvent(self,
                                                              self.user_addr,
                                                              self.user));
                    });
                }
                p.callback();
            });
        return p;
    };

    self.store_user = function(from_addr, user) {
        var p = new Promise();
        self.api.request("kv.set",
            {
                key: "users." + from_addr,
                value: user
            },
            function(reply) {
                p.callback();
            });
        return p;
    };

    self.on_unknown_command = function(cmd) {
        self.log("Received unknown command: " + JSON.stringify(cmd));
        self.done();
    };

    self.log = function(message) { self.api.log_info(message); };
    self.done = function() { self.api.done(); };

    self.api_request = function(cmd_name, cmd) {
        var p = new Promise();
        self.api.request(cmd_name, cmd, p.callback);
        return p;
    };

    self.reply = function(msg, save_user) {
        var p = self.switch_state(self.user.current_state);

        p.add_callback(function() {
            var continue_session = self.current_state.continue_session();
            if (!continue_session) {
                return self.on_event(new SessionCloseEvent(self, false));
            }
        });

        if (save_user) {
            p.add_callback(function() {
                self.log("Ending in state: " + self.current_state.name);
                self.log("Saving user: " + JSON.stringify(self.user));
                self.store_user(msg.from_addr, self.user);
            });
        }

        p.add_callback(function () {
            var continue_session = self.current_state.continue_session();
            self.api_request("outbound.reply_to", {
                content: self.current_state.display(),
                in_reply_to: msg.message_id,
                continue_session: continue_session
            });
        });

        return p;
    };

    self.on_inbound_message = function(cmd) {
        var msg = cmd.msg;
        var p = new Promise();

        p.add_callback(self.setup_config);
        p.add_callback(self.setup_metrics);
        p.add_callback(function () {
            return self.load_user(msg.from_addr);
        });
        p.add_callback(function () {
            if (msg.content == "!restart") {
                self.user = {};
                msg.content = "";
            }
            self.log("Loaded user " + self.user_addr + ": " + JSON.stringify(self.user));
            self.log("Content: " + msg.content);
            return self.switch_state(self.user.current_state);
        });
        p.add_callback(function () {
            self.log("Switched to state: " + self.current_state.name);
            if (msg.session_event == "close") {
                var ev_p = self.on_event(new SessionCloseEvent(self, true));
                ev_p.add_callback(function () {
                    return self.store_user(msg.from_addr, self.user);
                });
                return ev_p;
            }
            else if (msg.session_event == "new") {
                var ev_p = self.on_event(new SessionNewEvent(self));
                ev_p.add_callback(function () {
                    var state_done = new Promise();
                    self.current_state.new_session_event(function () {
                        state_done.callback();
                    });
                    return state_done;
                });
                ev_p.add_callback(function () {
                    return self.reply(msg, true);
                });
                return ev_p;
            }
            else {
                var ev_p = self.on_event(new SessionResumeEvent(self));
                if (msg.content) {
                    ev_p.add_callback(function() {
                        var state_done = new Promise();
                        self.current_state.input_event(
                            msg.content,
                            function () {
                                state_done.callback();
                            });
                        return state_done;
                    });
                }
                ev_p.add_callback(function() {
                    return self.reply(msg, true);
                });
                return ev_p;
            }
        });
        p.add_callback(self.done);

        p.callback();
    };

    self.on_inbound_event = function(cmd) {
        var event = cmd.msg;
        self.done();
    };

}


function StateCreator(start_state) {
    var self = this;

    self.start_state = start_state;
    self.state_creators = {};

    self.on_event = function(event) {
        var handler = self['on_' + event.event];
        if (typeof handler != 'undefined') {
            return maybe_promise(handler(event));
        }
        return success();
    };

    self.add_creator = function(state_name, state_creation_function) {
        if (self.state_creators[state_name]) {
            throw new StateException("Duplicate state '" + state_name + "'");
        }
        self.state_creators[state_name] = state_creation_function;
    };

    self.add_state = function(state, translate) {
        translate = (typeof translate == 'undefined') ? true : translate;
        self.add_creator(state.name, function(state_name, im) {
            if (translate) {
                state.translate(im.i18n);
            }
            return state;
        });
    };

    self.switch_state = function(state_name, im) {
        if (typeof state_name == "undefined")
            state_name = self.start_state;
        if (!self.state_creators[state_name]) {
            throw new StateException("Unknown state '" + state_name + "'");
        }
        var creator = self.state_creators[state_name];
        return maybe_promise(creator.call(self, state_name, im));
    };
}


// export

this.InteractionMachine = InteractionMachine;