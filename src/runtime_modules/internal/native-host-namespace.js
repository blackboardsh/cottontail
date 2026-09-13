// A bootstrap expression, evaluated before the module loader exists. Keep the
// exported host an ordinary object: JSClass property hooks drop all JSC locks
// on every lookup, including already-materialized native functions.
(function createNativeHostNamespace(materialize, names) {
  "use strict";
  const { defineProperty, getOwnPropertyDescriptor } = Object;
  const host = {};
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name === null) continue; // A direct binding replaces a legacy name.
    let initialized = false;
    let value;
    const get = function () {
      if (!initialized) {
        value = materialize(index);
        initialized = true;
      }
      // Seal/freeze may make the accessor non-configurable before first use.
      // Retain the cached identity without trying to redefine that property.
      // A detached old getter must not overwrite a caller's replacement either.
      const descriptor = getOwnPropertyDescriptor(host, name);
      if (descriptor?.get === get && descriptor.configurable) {
        defineProperty(host, name, {
          value, writable: true, enumerable: true, configurable: true,
        });
      }
      return value;
    };
    defineProperty(host, name, {
      enumerable: true,
      configurable: true,
      get,
      set(value) {
        // Match ordinary writable properties for inherited receivers, without
        // materializing a native function merely to replace it.
        defineProperty(this, name, {
          value, writable: true, enumerable: true, configurable: true,
        });
      },
    });
  }
  return host;
})
