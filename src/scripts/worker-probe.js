// Runs inside a worker before its own module (worker-monitor.js, only with ?debug): reports when the worker starts and
// finishes handling a message, so the debug overlay sees its load live – also during a long computation. Wraps
// self.onmessage and message listeners; an async handler counts until its promise settles. Plain script without
// imports (loaded as an asset).
// The worker runs from a blob: bootstrap – its own location is that blob URL, against which relative URLs do not
// resolve (an HDRI path "/hdr/…" failed in the HDR worker: "Failed to parse URL"). The real module's URL comes as
// ?base= on this script's URL; fetch and XMLHttpRequest resolve against it.
(() => {
    const base = new URL(import.meta.url).searchParams.get('base');
    if (base) {
        const resolve = url => (typeof url === 'string' ? new URL(url, base).href : url);
        const fetch = self.fetch.bind(self);
        self.fetch = (input, init) => fetch(resolve(input), init);
        if (self.XMLHttpRequest) {
            const open = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, resolve(url), ...rest); };
        }
    }
    const post = self.postMessage.bind(self);
    let depth = 0;
    const begin = () => { if (depth++ === 0) post({ __rindrProbe: 1 }); };
    const end = () => { if (--depth === 0) post({ __rindrProbe: 0 }); };
    const wrap = fn => function (event) {
        begin();
        let result;
        try {
            result = fn.call(this, event);
        } catch (err) {
            end();
            throw err;
        }
        if (result && typeof result.then === 'function') result.then(end, end);
        else end();
        return result;
    };
    let desc = null;
    for (let p = self; p && !desc; p = Object.getPrototypeOf(p)) desc = Object.getOwnPropertyDescriptor(p, 'onmessage');
    if (desc?.set) {
        let handler = null;
        Object.defineProperty(self, 'onmessage', {
            configurable: true,
            get: () => handler,
            set(fn) {
                handler = fn;
                desc.set.call(self, typeof fn === 'function' ? wrap(fn) : fn);
            },
        });
    }
    const wrapped = new WeakMap();
    const add = self.addEventListener.bind(self), remove = self.removeEventListener.bind(self);
    self.addEventListener = (type, fn, options) => {
        if (type !== 'message' || typeof fn !== 'function') return add(type, fn, options);
        if (!wrapped.has(fn)) wrapped.set(fn, wrap(fn));
        return add(type, wrapped.get(fn), options);
    };
    self.removeEventListener = (type, fn, options) => remove(type, (type === 'message' && wrapped.get(fn)) || fn, options);
})();
