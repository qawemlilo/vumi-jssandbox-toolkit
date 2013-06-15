// booklet.js
//  - State for showing paginated text.

var state = require("./state.js");
var State = state.State;


function BookletState(name, opts) {

    var self = this;
    opts = opts || {};
    State.call(self, name, opts.handlers);

    self.next = opts.next;
    self.pages = opts.pages; // pages are from 0 -> pages - 1
    self.page_changed = opts.page_changed; // page_changed(self) -> promise

    self.initial_page = opts.initial_page || 0;
    self.buttons = opts.buttons || {"1": -1, "2": +1, "0": "exit"};
    self.footer_text = opts.footer_text || "1 for prev, 2 for next, 0 to end.";

    self.page_text = "No page.";

    var orig_on_enter = self.on_enter;
    self.on_enter = function() {
        self.set_current_page(self.im.user, self.initial_page);
        return orig_on_enter();
    };

    self.get_current_page = function(user) {
        var pages = user.pages || {};
        return pages[self.name] || 0;
    };

    self.set_current_page = function(user, page) {
        if (typeof user.pages == 'undefined') {
            user.pages = {};
        }
        user.pages[self.name] = page;
    };

    self.inc_current_page = function(user, amount) {
        var page = self.get_current_page(user) + amount;
        page = page % self.pages;
        if (page < 0) {
            page += self.pages;
        }
        self.set_current_page(user, page);
    };

    self.set_page_text = function(text) {
        self.page_text = text;
    };

    self.input_event = function(content, done) {
        if (!content) { content = ""; }
        content = content.trim();

        var button = self.buttons[content];
        if (typeof button === "undefined") {
            done();
            return;
        }

        var amount = Number(button);
        if (!Number.isNaN(amount)) {
            self.inc_current_page(self.im.user, amount);
            var p = self.page_changed(self);
            p.add_callback(done);
            return;
        }

        if (button !== "exit") {
            done();
            return;
        }

        self.call_possible_function(
            self.next, self, [content],
            function (next) {
                self.im.set_user_state(next);
                self.save_response(content);
                done();
            }
        );
    };

    self.display = function() {
        return self.page_text;
    };
}