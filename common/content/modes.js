// Copyright (c) 2006-2008 by Martin Stubenschrott <stubenschrott@vimperator.org>
// Copyright (c) 2007-2011 by Doug Kearns <dougkearns@gmail.com>
// Copyright (c) 2008-2011 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

/** @scope modules */

var Modes = Module("modes", {
    init: function () {
        this.modeChars = {};
        this._main = 1;     // NORMAL
        this._extended = 0; // NONE

        this._lastShown = null;

        this._passNextKey = false;
        this._passAllKeys = false;
        this._recording = false;
        this._replaying = false; // playing a macro

        this._modeStack = update([], {
            pop: function pop() {
                if (this.length <= 1)
                    throw Error("Trying to pop last element in mode stack");
                return pop.superapply(this, arguments);
            }
        });

        this._modes = [];
        this._mainModes = [];
        this._modeMap = {};

        this.boundProperties = {};

        this.addMode("BASE", {
            description: "The base mode for all other modes",
            bases: [],
            count: false
        });
        this.addMode("MAIN", {
            char: "m",
            description: "The base mode for most other modes",
            bases: [this.BASE],
            count: false
        });
        this.addMode("COMMAND", {
            description: "The base mode for most modes which accept commands rather than input",
            hidden: true
        });

        this.addMode("NORMAL", {
            char: "n",
            description: "Active when nothing is focused",
            bases: [this.COMMAND],
            display: function () null
        });
        this.addMode("VISUAL", {
            char: "v",
            description: "Active when text is selected",
            display: function () "VISUAL" + (this._extended & modes.LINE ? " LINE" : ""),
            bases: [this.COMMAND],
            ownsFocus: true,
            passUnknown: false
        }, {
            leave: function (stack, newMode) {
                if (newMode.main == modes.CARET) {
                    let selection = content.getSelection();
                    if (selection && !selection.isCollapsed)
                        selection.collapseToStart();
                }
                else if (stack.pop)
                    editor.unselectText();
            }
        });
        this.addMode("CARET", {
            description: "Active when the caret is visible in the web content",
            bases: [this.COMMAND]
        }, {

            get pref()    prefs.get("accessibility.browsewithcaret"),
            set pref(val) prefs.set("accessibility.browsewithcaret", val),

            enter: function (stack) {
                if (stack.pop && !this.pref)
                    modes.pop();
                else if (!stack.pop && !this.pref)
                    this.pref = true;
            },

            leave: function (stack) {
                if (!stack.push && this.pref)
                    this.pref = false;
            }
        });
        this.addMode("TEXT_EDIT", {
            char: "t",
            description: "Vim-like editing of input elements",
            bases: [this.COMMAND],
            ownsFocus: true,
            passUnknown: false
        });
        this.addMode("OUTPUT_MULTILINE", {
            description: "Active when the multi-line output buffer is open",
            bases: [this.COMMAND],
        });

        this.addMode("INPUT", {
            char: "I",
            description: "The base mode for input modes, including Insert and Command Line",
            bases: [this.MAIN],
            input: true
        });
        this.addMode("INSERT", {
            char: "i",
            description: "Active when an input element is focused",
            input: true,
            ownsFocus: true
        });

        this.addMode("EMBED", {
            input: true,
            description: "Active when an <embed> or <object> element is focused",
            ownsFocus: true,
            passthrough: true
        });

        this.addMode("PASS_THROUGH", {
            description: "All keys but <C-v> are ignored by " + config.appName,
            bases: [this.BASE],
            hidden: true,
            passthrough: true
        });
        this.addMode("QUOTE", {
            description: "The next key sequence is ignored by " + config.appName + ", unless in Pass Through mode",
            bases: [this.BASE],
            hidden: true,
            passthrough: true,
            display: function () modes.getStack(1).main == modes.PASS_THROUGH
                ? (modes.getStack(2).main.display() || modes.getStack(2).main.name) + " (next)"
                : "PASS THROUGH (next)"
        }, {
            // Fix me.
            preExecute: function (map) { if (modes.main == modes.QUOTE && map.name !== "<C-v>") modes.pop(); },
            postExecute: function (map) { if (modes.main == modes.QUOTE && map.name === "<C-v>") modes.pop(); },
            onKeyPress: function () { if (modes.main == modes.QUOTE) modes.pop() }
        });
        this.addMode("IGNORE", { hidden: true }, {
            onKeyPress: function (event) Events.KILL,
            bases: [],
            passthrough: true
        });

        this.addMode("MENU", {
            description: "Active when a menu or other pop-up is open",
            input: true,
            passthrough: true
        });

        this.addMode("LINE", {
            extended: true, hidden: true
        });

        this.push(this.NORMAL, 0, {
            enter: function (stack, prev) {
                if (prefs.get("accessibility.browsewithcaret"))
                    prefs.set("accessibility.browsewithcaret", false);

                statusline.updateUrl();
                if (!stack.fromFocus && (prev.main.input || prev.main.ownsFocus))
                    dactyl.focusContent(true);
                if (prev.main == modes.NORMAL) {
                    dactyl.focusContent(true);
                    for (let frame in values(buffer.allFrames())) {
                        // clear any selection made
                        let selection = frame.getSelection();
                        if (selection && !selection.isCollapsed)
                            selection.collapseToStart();
                    }
                }

            }
        });
    },
    cleanup: function () {
        modes.reset();
    },

    _getModeMessage: function () {
        // when recording a macro
        let macromode = "";
        if (this.recording)
            macromode = "recording";
        else if (this.replaying)
            macromode = "replaying";

        let val = this._modeMap[this._main].display();
        if (val)
            return "-- " + val + " --" + macromode;;
        return macromode;
    },

    NONE: 0,

    __iterator__: function () array.iterValues(this.all),

    get all() this._modes.slice(),

    get mainModes() (mode for ([k, mode] in Iterator(modes._modeMap)) if (!mode.extended && mode.name == k)),

    get mainMode() this._modeMap[this._main],

    get passThrough() !!(this.main & (this.PASS_THROUGH|this.QUOTE)) ^ (this.getStack(1).main === this.PASS_THROUGH),

    get topOfStack() this._modeStack[this._modeStack.length - 1],

    addMode: function (name, options, params) {
        let mode = Modes.Mode(name, options, params);

        this[name] = mode;
        if (mode.char)
            this.modeChars[mode.char] = (this.modeChars[mode.char] || []).concat(mode);
        this._modeMap[name] = mode;
        this._modeMap[mode] = mode;

        this._modes.push(mode);
        if (!mode.extended)
            this._mainModes.push(mode);

        dactyl.triggerObserver("mode-add", mode);
    },

    dumpStack: function () {
        util.dump("Mode stack:");
        for (let [i, mode] in array.iterItems(this._modeStack))
            util.dump("    " + i + ": " + mode);
    },

    getMode: function (name) this._modeMap[name],

    getStack: function (idx) this._modeStack[this._modeStack.length - idx - 1] || this._modeStack[0],

    get stack() this._modeStack.slice(),

    getCharModes: function (chr) (this.modeChars[chr] || []).slice(),

    matchModes: function (obj)
        this._modes.filter(function (mode) Object.keys(obj)
                                                 .every(function (k) obj[k] == (mode[k] || false))),

    // show the current mode string in the command line
    show: function show() {
        let msg = null;
        if (options["showmode"])
            msg = this._getModeMessage();
        if (loaded.commandline)
            commandline.widgets.mode = msg || null;
    },

    remove: function remove(mode) {
        if (this.stack.some(function (m) m.main == mode)) {
            this.pop(mode);
            this.pop();
        }
    },

    delayed: [],
    delay: function (callback, self) { this.delayed.push([callback, self]); },

    save: function save(id, obj, prop, test) {
        if (!(id in this.boundProperties))
            for (let elem in array.iterValues(this._modeStack))
                elem.saved[id] = { obj: obj, prop: prop, value: obj[prop], test: test };
        this.boundProperties[id] = { obj: Cu.getWeakReference(obj), prop: prop, test: test };
    },

    // helper function to set both modes in one go
    set: function set(mainMode, extendedMode, params, stack) {
        params = params || this.getMode(mainMode || this.main).params;

        if (!stack && mainMode != null && this._modeStack.length > 1)
            this.reset();

        let oldMain = this._main, oldExtended = this._extended;

        if (extendedMode != null)
            this._extended = extendedMode;
        if (mainMode != null) {
            this._main = mainMode;
            if (!extendedMode)
                this._extended = this.NONE;
        }

        if (stack && stack.pop && stack.pop.params.leave)
            dactyl.trapErrors("leave", stack.pop.params,
                              stack, this.topOfStack);

        let push = mainMode != null && !(stack && stack.pop) &&
            Modes.StackElement(this._main, this._extended, params, {});

        if (push && this.topOfStack) {
            if (this.topOfStack.params.leave)
                dactyl.trapErrors("leave", this.topOfStack.params,
                                  { push: push }, push);

            for (let [id, { obj, prop, test }] in Iterator(this.boundProperties)) {
                if (!obj.get())
                    delete this.boundProperties[id];
                else
                    this.topOfStack.saved[id] = { obj: obj.get(), prop: prop, value: obj.get()[prop], test: test };
            }
        }

        let delayed = this.delayed;
        this.delayed = [];

        let prev = stack && stack.pop || this.topOfStack;
        if (push)
            this._modeStack.push(push);

        if (stack && stack.pop)
            for (let { obj, prop, value, test } in values(this.topOfStack.saved))
                if (!test || !test(stack, prev))
                    obj[prop] = value;

        this.show();

        delayed.forEach(function ([fn, self]) dactyl.trapErrors(fn, self));

        if (this.topOfStack.params.enter && prev)
            dactyl.trapErrors("enter", this.topOfStack.params,
                              push ? { push: push } : stack || {},
                              prev);

        dactyl.triggerObserver("modeChange", [oldMain, oldExtended], [this._main, this._extended], stack);
        this.show();
    },

    onCaretChange: function onPrefChange(value) {
        if (!value && modes.main == modes.CARET)
            modes.pop();
        if (value && modes.main == modes.NORMAL)
            modes.push(modes.CARET);
    },

    push: function push(mainMode, extendedMode, params) {
        this.set(mainMode, extendedMode, params, { push: this.topOfStack });
    },

    pop: function pop(mode, args) {
        while (this._modeStack.length > 1 && this.main != mode) {
            let a = this._modeStack.pop();
            this.set(this.topOfStack.main, this.topOfStack.extended, this.topOfStack.params,
                     update({ pop: a }, args || {}));

            if (mode == null)
                return;
        }
    },

    replace: function replace(mode, oldMode) {
        while (oldMode && this._modeStack.length > 1 && this.main != oldMode)
            this.pop();

        if (this._modeStack.length > 1)
            this.set(mode, null, null, { push: this.topOfStack, pop: this._modeStack.pop() });
        this.push(mode);
    },

    reset: function reset() {
        if (this._modeStack.length == 1 && this.topOfStack.params.enter)
            this.topOfStack.params.enter({}, this.topOfStack);
        while (this._modeStack.length > 1)
            this.pop();
    },

    get recording() this._recording,
    set recording(value) { this._recording = value; this.show(); },

    get replaying() this._replaying,
    set replaying(value) { this._replaying = value; this.show(); },

    get main() this._main,
    set main(value) { this.set(value); },

    get extended() this._extended,
    set extended(value) { this.set(null, value); }
}, {
    Mode: Class("Mode", {
        init: function init(name, options, params) {
            update(this, {
                id: 1 << Modes.Mode._id++,
                name: name,
                params: params || {}
            }, options);
        },

        isinstance: function (obj)
            this.allBases.indexOf(obj) >= 0 || callable(obj) && this instanceof obj,

        allBases: Class.memoize(function () {
            let seen = {}, res = [], queue = this.bases;
            for (let mode in array.iterValues(queue))
                if (!set.add(seen, mode)) {
                    res.push(mode);
                    queue.push.apply(queue, mode.bases);
                }
            return res;
        }),

        get bases() this.input ? [modes.INPUT] : [modes.MAIN],

        get count() !this.input,

        get description() this._display,

        _display: Class.memoize(function () this.name.replace("_", " ", "g")),

        display: function () this._display,

        extended: false,

        hidden: false,

        input: false,

        get passUnknown() this.input,

        get mask() this,

        get toStringParams() [this.name],

        valueOf: function () this.id
    }, {
        _id: 0
    }),
    StackElement: (function () {
        const StackElement = Struct("main", "extended", "params", "saved");
        StackElement.className = "Modes.StackElement";
        StackElement.defaultValue("params", function () this.main.params);

        update(StackElement.prototype, {
            get toStringParams() !loaded.modes ? this.main.name : [
                this.main.name,
                <>({ modes.all.filter(function (m) this.extended & m, this).map(function (m) m.name).join("|") })</>
            ]
        });
        return StackElement;
    })(),
    cacheId: 0,
    boundProperty: function boundProperty(desc) {
        desc = desc || {};
        let id = this.cacheId++, value;
        return Class.Property(update({
            enumerable: true,
            configurable: true,
            init: function (prop) update(this, {
                get: function () {
                    if (desc.get)
                        var val = desc.get.call(this, value);
                    return val === undefined ? value : val;
                },
                set: function (val) {
                    modes.save(id, this, prop, desc.test);
                    if (desc.set)
                        value = desc.set.call(this, val);
                    value = !desc.set || value === undefined ? val : value;
                }
            })
        }, desc));
    }
}, {
    mappings: function () {
        mappings.add([modes.BASE, modes.NORMAL],
            ["<Esc>", "<C-[>"],
            "Return to NORMAL mode",
            function () { modes.reset(); });

        mappings.add([modes.INPUT, modes.COMMAND, modes.PASS_THROUGH, modes.QUOTE],
            ["<Esc>", "<C-[>"],
            "Return to the previous mode",
            function () { modes.pop(); });

        mappings.add([modes.MENU], ["<Esc>"],
            "Close the current popup",
            function () Events.PASS);

        mappings.add([modes.MENU], ["<C-[>"],
            "Close the current popup",
            function () { events.feedkeys("<Esc>"); });
    },
    prefs: function () {
        prefs.watch("accessibility.browsewithcaret", function () modes.onCaretChange.apply(modes, arguments));
    }
});

// vim: set fdm=marker sw=4 ts=4 et:
