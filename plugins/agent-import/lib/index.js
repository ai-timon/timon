var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// src/apply.ts
import { randomUUID } from "node:crypto";

// src/contract.ts
var SOURCE_SLOT = "agentimport.source";
var APPLIED_EVENT_NAME = "applied";
var APPLIED_EVENT_VERSION = 1;
var IMPORT_ELEMENTS = ["soul", "memory", "skills", "mcp", "routines", "team"];
var DEFAULT_IMPORT_ROLE = "research";

// ../../orchestrator/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str2) {
  return str2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a3;
    (_a3 = iss).path ?? (_a3.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function attachSchema(issues, start, inst) {
  var _a3;
  for (let i = start; i < issues.length; i++) {
    (_a3 = issues[i]).schema ?? (_a3.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config2) {
  var _a3;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a3 = iss).schema ?? (_a3.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
  const { inst: _inst, schema: _schema, continue: _continue, input: _input, ...rest } = iss;
  rest.path ?? (rest.path = []);
  rest.message = message;
  if (ctx?.reportInput) {
    rest.input = _input;
  }
  return rest;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str2) {
  const units = str2.length;
  if (!highSurrogate.test(str2))
    return units;
  let count = units;
  for (let i = 0; i < units - 1; i++) {
    if ((str2.charCodeAt(i) & 64512) === 55296 && (str2.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? void 0 : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return void 0;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = void 0;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err2) {
        delete this[key];
        broke = broke || outer;
        throw err2;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: void 0 };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}

// ../../orchestrator/node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: void 0, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition();
      }
      try {
        return new Definition();
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition();
}
// @__NO_SIDE_EFFECTS__
function $constructor(name2, initializer2, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = /* @__PURE__ */ new Set();
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = void 0;
      }
    }
    if (inst._zod.traits.has(name2)) {
      return;
    }
    inst._zod.traits.add(name2);
    initializer2(inst, def);
    if (initialized) {
      const own2 = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own2;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own2;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto2 = _.prototype;
    for (const k in proto2) {
      if (!Object.prototype.hasOwnProperty.call(proto2, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto2[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name2 });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = void 0;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name2);
    }
  });
  Object.defineProperty(_, "name", { value: name2 });
  return _;
}
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// ../../orchestrator/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _zodDesc2 = { value: void 0, enumerable: false };
var _issuesDesc = { value: void 0, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _zodDesc2.value = inst._zod;
  Object.defineProperty(inst, "_zod", _zodDesc2);
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _zodDesc2.value = void 0;
  _issuesDesc.value = void 0;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, void 0, {
  Parent: Error
});

// ../../orchestrator/node_modules/zod/v4/core/parse.js
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError();
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);

// ../../orchestrator/node_modules/zod/v4/core/regexes.js
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;

// ../../orchestrator/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a3;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a3 = inst._zod).onattach ?? (_a3.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== void 0;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt2 = def.format?.includes("int");
  const origin = isInt2 ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt2)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt2) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a3;
  $ZodCheck.init(inst, def);
  (_a3 = inst._zod.def).when ?? (_a3.when = _whenHasLength);
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a3;
  $ZodCheck.init(inst, def);
  (_a3 = inst._zod.def).when ?? (_a3.when = _whenHasLength);
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a3, _b2;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a3 = inst._zod).check ?? (_a3.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b2 = inst._zod).check ?? (_b2.check = () => {
    });
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});

// ../../orchestrator/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 5,
  patch: 1
};

// ../../orchestrator/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a3;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  // Wrappers extend this by installing a richer factory over it; reading it eagerly would defeat the laziness.
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r) => r.success ? { value: r.data } : { issues: r.error?.issues };
function standardProps(inst) {
  return {
    validate: (value) => {
      try {
        return toStandardResult(safeParse(inst, value));
      } catch (_) {
        return safeParseAsync(inst, value).then(toStandardResult);
      }
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
  if (def.local || def.precision === -1) {
    inst._zod.bag.laxFormat = true;
    inst._zod.onattach.push((s) => {
      s._zod.bag.laxFormat = true;
    });
  }
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== void 0 && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === void 0) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: void 0,
        path: [key]
      });
    }
    return;
  }
  if (result.value === void 0) {
    if (isPresent) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    // string-only: handleCatchall matches it against `for...in`, which never yields a symbol
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  for (const key in input) {
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      // Describes the shape of the input, not the validity of the parsed value, so it never aborts. The parse still fails; the schema's own checks just get to run first, and an enclosing intersection can reconcile the key against a sibling operand.
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var propShapes = /* @__PURE__ */ new WeakMap();
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    propShapes.set(def, sh);
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        propShapes.set(def, newSh);
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, /* @__PURE__ */ new Set());
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== void 0)
          propValues[key].add(void 0);
      }
    }
    return propValues;
  });
  const isObject3 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject3(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.allKeys) {
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazyInternal(inst, "propValues", (zod) => {
    const propValues = {};
    for (const option of zod.def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!Object.prototype.hasOwnProperty.call(propValues, k)) {
          assignProp(propValues, k, /* @__PURE__ */ new Set());
        }
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  def.options.forEach((option, i) => {
    const propShape = propShapes.get(option._zod.def);
    if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def.discriminator)) {
      throw new Error(`Invalid discriminated union option at index "${i}"`);
    }
  });
  const disc = cached(() => {
    const opts = def.options;
    const map = /* @__PURE__ */ new Map();
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map.set(v, o);
      }
    }
    return map;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback || ctx.direction === "backward") {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      options: Array.from(disc.value.keys()),
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[outKey] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[outKey] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  const patternValues = values.filter((k) => propertyKeyTypes.has(typeof k));
  inst._zod.pattern = new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(def.values.length ? `^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? void 0 : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === void 0) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result2) => handleOptionalResult(payload, result2));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? /* @__PURE__ */ new Set([...zod.def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}

// ../../orchestrator/node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _nonnegative(params) {
  return /* @__PURE__ */ _gte(0, params);
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}

// ../../orchestrator/node_modules/zod/v4/mini/schemas.js
var ZodMiniType = /* @__PURE__ */ $constructor("ZodMiniType", (inst, def) => {
  if (!inst._zod)
    throw new Error("Uninitialized schema in ZodMiniType.");
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
}, {
  // `with` is an alias for `check`: the same function object, not a wrapper.
  get with() {
    return this.check;
  },
  set with(value) {
    own(this, "with", value);
  },
  parse(data, params) {
    return parse(this, data, params, { callee: this.parse });
  },
  parseAsync(data, params) {
    return parseAsync(this, data, params, { callee: this.parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  check(...checks) {
    const def = this.def;
    return this.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }, { parent: true });
  },
  clone(_def, params) {
    return clone(this, _def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta2) {
    reg.add(this, meta2);
    return this;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  }
});
var ZodMiniString = /* @__PURE__ */ $constructor("ZodMiniString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function string2(params) {
  return _string(ZodMiniString, params);
}
var ZodMiniStringFormat = /* @__PURE__ */ $constructor("ZodMiniStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  ZodMiniString.init(inst, def);
});
var ZodMiniNumber = /* @__PURE__ */ $constructor("ZodMiniNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function number2(params) {
  return _number(ZodMiniNumber, params);
}
var ZodMiniNumberFormat = /* @__PURE__ */ $constructor("ZodMiniNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodMiniNumber.init(inst, def);
});
function int(params) {
  return _int(ZodMiniNumberFormat, params);
}
var ZodMiniBoolean = /* @__PURE__ */ $constructor("ZodMiniBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function boolean2(params) {
  return _boolean(ZodMiniBoolean, params);
}
var ZodMiniNever = /* @__PURE__ */ $constructor("ZodMiniNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function never(params) {
  return _never(ZodMiniNever, params);
}
var ZodMiniArray = /* @__PURE__ */ $constructor("ZodMiniArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function array(element, params) {
  return new ZodMiniArray({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
var ZodMiniObject = /* @__PURE__ */ $constructor("ZodMiniObject", (inst, def) => {
  $ZodObject.init(inst, def);
  ZodMiniType.init(inst, def);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
});
// @__NO_SIDE_EFFECTS__
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodMiniObject(def);
}
// @__NO_SIDE_EFFECTS__
function strictObject(shape, params) {
  return new ZodMiniObject({
    type: "object",
    shape,
    catchall: /* @__PURE__ */ never(),
    ...normalizeParams(params)
  });
}
var ZodMiniUnion = /* @__PURE__ */ $constructor("ZodMiniUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function union(options, params) {
  return new ZodMiniUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodMiniDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodMiniDiscriminatedUnion", (inst, def) => {
  $ZodDiscriminatedUnion.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function discriminatedUnion(discriminator, options, params) {
  return new ZodMiniDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
var ZodMiniRecord = /* @__PURE__ */ $constructor("ZodMiniRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodMiniRecord({
      type: "record",
      keyType: /* @__PURE__ */ string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodMiniRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodMiniEnum = /* @__PURE__ */ $constructor("ZodMiniEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodMiniType.init(inst, def);
  inst.options = Object.values(def.entries);
});
// @__NO_SIDE_EFFECTS__
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodMiniEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodMiniLiteral = /* @__PURE__ */ $constructor("ZodMiniLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function literal(value, params) {
  return new ZodMiniLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodMiniOptional = /* @__PURE__ */ $constructor("ZodMiniOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function optional(innerType) {
  return new ZodMiniOptional({
    type: "optional",
    innerType
  });
}
var ZodMiniNullable = /* @__PURE__ */ $constructor("ZodMiniNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function nullable(innerType) {
  return new ZodMiniNullable({
    type: "nullable",
    innerType
  });
}
var ZodMiniCustom = /* @__PURE__ */ $constructor("ZodMiniCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodMiniType.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function refine(fn, _params = {}) {
  return _refine(ZodMiniCustom, fn, _params);
}

// ../../orchestrator/node_modules/zod/v4/mini/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodMiniISODate: () => ZodMiniISODate,
  ZodMiniISODateTime: () => ZodMiniISODateTime,
  ZodMiniISODuration: () => ZodMiniISODuration,
  ZodMiniISOTime: () => ZodMiniISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodMiniISODateTime = /* @__PURE__ */ $constructor("ZodMiniISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodMiniStringFormat.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function datetime2(params) {
  return _isoDateTime(ZodMiniISODateTime, params);
}
var ZodMiniISODate = /* @__PURE__ */ $constructor("ZodMiniISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodMiniStringFormat.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function date2(params) {
  return _isoDate(ZodMiniISODate, params);
}
var ZodMiniISOTime = /* @__PURE__ */ $constructor("ZodMiniISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodMiniStringFormat.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function time2(params) {
  return _isoTime(ZodMiniISOTime, params);
}
var ZodMiniISODuration = /* @__PURE__ */ $constructor("ZodMiniISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodMiniStringFormat.init(inst, def);
});
// @__NO_SIDE_EFFECTS__
function duration2(params) {
  return _isoDuration(ZodMiniISODuration, params);
}

// src/event.ts
var AppliedSchema = strictObject({
  sourceRef: string2().check(_minLength(1), _maxLength(300)),
  agent: string2().check(_minLength(1), _maxLength(100)),
  origin: string2().check(_regex(/^plugin:[a-z0-9][a-z0-9-]*$/)),
  sourceApp: string2().check(_minLength(1), _maxLength(64))
});
function appliedEventId(pluginId) {
  return `${pluginId}:${APPLIED_EVENT_NAME}@${APPLIED_EVENT_VERSION}`;
}
function registerAppliedEvent(ctx) {
  return ctx.businessEvents.register({
    name: APPLIED_EVENT_NAME,
    version: APPLIED_EVENT_VERSION,
    payloadSchema: { parse: (value) => AppliedSchema.parse(value) }
  });
}
function publishApplied(ctx, importId, input) {
  const payload = AppliedSchema.parse({ ...input, origin: `plugin:${ctx.id}` });
  return ctx.businessEvents.publish(appliedEventId(ctx.id), { id: `${importId}:${input.sourceRef}`, payload });
}

// src/records.ts
import { createHash } from "node:crypto";
var REF_PREFIX = "ref:";
var SKILL_PREFIX = "skill:";
var MCP_PREFIX = "mcp:";
var FINGERPRINTED_DOCS = ["SOUL.md", "system-prompt.md"];
var OwnerSchema = optional(nullable(string2()));
var ImportRecordSchema = strictObject({
  sourceApp: string2(),
  sourceRef: string2(),
  /**
   * Other refs of the same source agent: the name form an older Timon export
   * gave it (`source-ref.ts`). An archive under one of them updates this agent.
   */
  aliases: optional(array(string2())),
  ownerUserId: OwnerSchema,
  agent: string2(),
  /** SHA-256 of each document as the import left it; `null` = absent. */
  docs: record(string2(), nullable(string2())),
  skills: array(string2()),
  mcpServers: array(string2()),
  triggers: array(string2()),
  rules: array(int()),
  /** The team the import put the agent in; absent on a record written before. */
  team: optional(nullable(string2())),
  /** Somebody else changed the agent since the import. */
  touched: boolean2(),
  importedAt: number2()
});
var OwnedSchema = strictObject({ sourceApp: string2(), sourceId: string2(), ownerUserId: OwnerSchema });
var digest = (...parts) => createHash("sha256").update(parts.join("\0")).digest("hex");
var fingerprint = (content) => content === null ? null : digest(content);
function ownedBy(owner, caller) {
  if (caller.superadmin) return true;
  return owner !== void 0 && owner === caller.userId;
}
function createRecords(kv) {
  const refKey = (sourceApp, sourceRef, owner) => owner === void 0 ? REF_PREFIX + digest(sourceApp, sourceRef) : REF_PREFIX + digest(sourceApp, sourceRef, "owner", owner ?? "");
  async function all() {
    const out = [];
    for (const { key, value } of await kv.list(REF_PREFIX)) {
      const parsed = ImportRecordSchema.safeParse(value);
      if (parsed.success) out.push({ key, record: parsed.data });
    }
    return out;
  }
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  return {
    /**
     * The record of this source agent the caller may build on: its own, else —
     * for a superadmin only — anybody's, a record without an owner included;
     * among several accounts' records, the oldest import. `aliases` are the
     * older refs of the same source agent: a record still keyed by one of
     * them is found, as is a record that holds `sourceRef` among its own
     * aliases (an older archive of an agent since keyed by its stable id),
     * both after an exact match. Two alias lists are never compared: the name
     * form of a renamed agent's copy must not catch a new agent of that name.
     */
    async find(sourceApp, sourceRef, caller, aliases = []) {
      const key = refKey(sourceApp, sourceRef, caller.userId);
      const parsed = ImportRecordSchema.safeParse(await kv.get(key));
      if (parsed.success && ownedBy(parsed.data.ownerUserId, caller)) return { key, record: parsed.data };
      const refs = /* @__PURE__ */ new Set([sourceRef, ...aliases]);
      const candidates = (await all()).filter(({ record: record2 }) => record2.sourceApp === sourceApp && ownedBy(record2.ownerUserId, caller) && (refs.has(record2.sourceRef) || (record2.aliases ?? []).includes(sourceRef)));
      const rank = (record2) => record2.sourceRef === sourceRef ? 0 : 1;
      return candidates.sort((a, b) => rank(a.record) - rank(b.record) || a.record.importedAt - b.record.importedAt)[0] ?? null;
    },
    /** Writes `record` under its owner's key; `previousKey` (another key it was read from) is dropped. */
    async put(record2, previousKey) {
      const key = refKey(record2.sourceApp, record2.sourceRef, record2.ownerUserId);
      await kv.set(key, record2);
      if (previousKey && previousKey !== key) await kv.del(previousKey);
    },
    /** Every record naming `agent` (one normally). */
    async byAgent(agent) {
      return (await all()).filter(({ record: record2 }) => sameName(record2.agent, agent));
    },
    async set(key, record2) {
      await kv.set(key, record2);
    },
    async del(key) {
      await kv.del(key);
    },
    /** A skill this plugin wrote, and which source skill it holds. */
    async skill(id) {
      const parsed = OwnedSchema.safeParse(await kv.get(SKILL_PREFIX + id));
      return parsed.success ? parsed.data : null;
    },
    async putSkill(id, owner) {
      await kv.set(SKILL_PREFIX + id, owner);
    },
    async dropSkill(id) {
      await kv.del(SKILL_PREFIX + id);
    },
    async mcp(id) {
      const parsed = OwnedSchema.safeParse(await kv.get(MCP_PREFIX + id));
      return parsed.success ? parsed.data : null;
    },
    async putMcp(id, owner) {
      await kv.set(MCP_PREFIX + id, owner);
    },
    async dropMcp(id) {
      await kv.del(MCP_PREFIX + id);
    }
  };
}
function trackAgents(ctx, records) {
  const ours = (origin) => origin.kind === "plugin" && origin.id === ctx.id;
  ctx.events.on("agent_updated", async (ev) => {
    if (ours(ev.origin)) return;
    const lookup = ev.previousName ?? ev.agent.name;
    for (const { key, record: record2 } of await records.byAgent(lookup)) {
      const next = { ...record2, agent: ev.agent.name };
      if (ev.changed.some((field) => field !== "name")) next.touched = true;
      await records.set(key, next);
    }
  });
  ctx.events.on("agent_deleted", async (ev) => {
    for (const { key } of await records.byAgent(ev.agent.name)) await records.del(key);
  });
}

// src/apply.ts
var ERROR_MAX = 300;
var ALIASES_MAX = 16;
var errorText = (err2) => (err2 instanceof Error && err2.message ? err2.message : "unknown error").replace(/\s+/g, " ").slice(0, ERROR_MAX);
var codeOf = (err2) => err2?.code;
async function applyPlan(ctx, records, plan) {
  const importId = randomUUID();
  const teams = /* @__PURE__ */ new Map();
  const results = [];
  for (const agent of plan.agents) {
    const base = { sourceRef: agent.source.sourceRef, displayName: agent.source.displayName };
    if (agent.action === "skip") {
      results.push({ ...base, agent: agent.record ? agent.finalName : null, status: "skipped", warnings: agent.warnings });
      continue;
    }
    const warnings = [...agent.warnings];
    const undo = [];
    try {
      await applyAgent(ctx, records, plan.sourceApp, agent, teams, undo, warnings);
    } catch (err2) {
      const failures = await rollback(ctx, undo);
      if (failures.length > 0) warnings.push(`Could not undo everything: ${failures.join(", ")}.`);
      ctx.log.warn(`import of ${agent.finalName} failed and was rolled back:`, errorText(err2));
      results.push({
        ...base,
        agent: agent.action === "update" ? agent.finalName : null,
        status: "failed",
        error: errorText(err2),
        warnings
      });
      continue;
    }
    try {
      await publishApplied(ctx, importId, { sourceRef: agent.source.sourceRef, agent: agent.finalName, sourceApp: plan.sourceApp });
    } catch (err2) {
      ctx.log.warn("agent-import:applied could not be published:", errorText(err2));
    }
    results.push({ ...base, agent: agent.finalName, status: agent.action === "update" ? "updated" : "created", warnings });
  }
  return { agents: results, warnings: plan.warnings };
}
async function rollback(ctx, undo) {
  const failures = [];
  for (const step of undo.reverse()) {
    try {
      await step.run();
    } catch (err2) {
      failures.push(step.what);
      ctx.log.warn(`rollback of ${step.what} failed:`, errorText(err2));
    }
  }
  return failures;
}
async function applyAgent(ctx, records, sourceApp, plan, teams, undo, warnings) {
  const name2 = plan.finalName;
  const creating = plan.action === "create";
  const ownerOf = (owned) => owned && owned.ownerUserId !== void 0 ? owned.ownerUserId : plan.ownerUserId;
  const skillIds = [];
  for (const skill of plan.skills) {
    const before = await ctx.skills.get(skill.finalId);
    const existed = before !== void 0;
    const owned = existed ? await records.skill(skill.finalId) : null;
    await ctx.skills.put(skill.finalId, skill.content);
    if (!existed) {
      undo.push({ what: `skill ${skill.finalId}`, run: async () => {
        await ctx.skills.rm(skill.finalId);
        await records.dropSkill(skill.finalId);
      } });
    } else if (before.content !== skill.content) {
      undo.push({ what: `skill ${skill.finalId}`, run: () => ctx.skills.put(skill.finalId, before.content) });
    }
    await records.putSkill(skill.finalId, { sourceApp, sourceId: skill.sourceId, ownerUserId: ownerOf(owned) });
    if (!skillIds.includes(skill.finalId)) skillIds.push(skill.finalId);
  }
  const serverIds = [];
  for (const server of plan.mcp) {
    const existed = await ctx.mcpServers.get(server.finalId) !== void 0;
    const owned = existed ? await records.mcp(server.finalId) : null;
    await ctx.mcpServers.put(server.finalId, {
      name: server.name,
      description: `Imported from ${sourceApp}.`,
      transport: { type: "http", url: server.url }
    });
    if (!existed) {
      undo.push({ what: `MCP server ${server.finalId}`, run: async () => {
        await ctx.mcpServers.rm(server.finalId);
        await records.dropMcp(server.finalId);
      } });
    }
    await records.putMcp(server.finalId, { sourceApp, sourceId: server.name, ownerUserId: ownerOf(owned) });
    if (!serverIds.includes(server.finalId)) serverIds.push(server.finalId);
  }
  const settings = (fallback) => ({
    ...plan.setRole ? { role: fallback && plan.fromSource.role ? DEFAULT_IMPORT_ROLE : plan.role } : {},
    ...typeof plan.project === "string" && !(fallback && plan.fromSource.project) ? { project: plan.project } : {},
    ...plan.project === null ? { project: null } : {},
    ...plan.cwd && !(fallback && plan.fromSource.cwd) ? { cwd: plan.cwd } : {},
    ...plan.backend && !fallback ? { backend: plan.backend } : {},
    ...plan.backend && plan.model && !fallback ? { model: plan.model } : {}
  });
  const fromSource = plan.fromSource.role || plan.fromSource.project || plan.fromSource.cwd || plan.backend !== null;
  if (!creating) {
    const prompt = await ctx.agents.docs.get(name2, "system-prompt.md");
    const written = [...plan.soul !== null ? ["SOUL.md"] : [], ...plan.docs.map((d) => d.name)];
    const docsBefore = await Promise.all(written.map(async (file) => [file, await ctx.agents.docs.get(name2, file)]));
    undo.push({
      what: `documents of ${name2}`,
      run: async () => {
        await ctx.agents.update(name2, { systemPrompt: prompt ?? "" });
        for (const [file, content] of docsBefore) {
          if (content) await ctx.agents.docs.put(name2, file, content);
          else await ctx.agents.docs.rm(name2, file);
        }
      }
    });
  }
  const write = async (fallback) => {
    if (creating) {
      await ctx.agents.create({
        name: name2,
        systemPrompt: plan.systemPrompt,
        role: plan.role,
        ...plan.directives !== null ? { directives: plan.directives } : {},
        ...settings(fallback),
        ...plan.selected.skills ? { skills: skillIds } : {},
        ...plan.selected.mcp ? { mcpServers: serverIds } : {}
      });
    } else {
      await ctx.agents.update(name2, {
        systemPrompt: plan.systemPrompt,
        ...plan.directives !== null ? { directives: plan.directives } : {},
        ...settings(fallback),
        ...plan.selected.skills ? { skills: skillIds } : {},
        ...plan.selected.mcp ? { mcpServers: serverIds } : {}
      });
    }
  };
  try {
    await write(false);
  } catch (err2) {
    const code = codeOf(err2);
    if (!fromSource || code !== "invalid" && code !== "forbidden") throw err2;
    await write(true);
    warnings.push(`The settings of the source were refused here (${errorText(err2)}): the agent uses Timon's defaults for them.`);
  }
  if (creating) undo.push({ what: `agent ${name2}`, run: () => ctx.agents.delete(name2, { purge: true }) });
  if (plan.soul !== null) await ctx.agents.docs.put(name2, "SOUL.md", plan.soul);
  for (const doc of plan.docs) await ctx.agents.docs.put(name2, doc.name, doc.content);
  if (plan.avatar) await ctx.agents.setAvatar(name2, plan.avatar);
  const ruleIds = [];
  for (const memory of plan.memories) {
    try {
      const rule = await ctx.memory.rules.add({ text: memory.text, scope: "agent", agent: name2, kind: memory.kind });
      ruleIds.push(rule.id);
      undo.push({ what: `rule ${rule.id}`, run: () => ctx.memory.rules.rm(rule.id) });
    } catch (err2) {
      if (codeOf(err2) !== "conflict") throw err2;
    }
  }
  const triggerIds = [];
  for (const routine of plan.routines) {
    const input = (enabled) => ({
      source: "schedule",
      name: `${name2}: ${routine.name}`.slice(0, 120),
      enabled,
      config: { cron: routine.cron, ...routine.tz ? { tz: routine.tz } : {} },
      actions: [{ type: "task", agent: name2, prompt: routine.instruction, title: routine.name, raw: true }]
    });
    let created;
    try {
      created = await ctx.triggers.create(input(routine.enabled));
    } catch (err2) {
      if (!routine.enabled || codeOf(err2) !== "forbidden") throw err2;
      created = await ctx.triggers.create(input(false));
      warnings.push(`Routine "${routine.name}" is imported switched off: this plugin is not approved to start tasks on its own.`);
    }
    const id = created.trigger.id;
    triggerIds.push(id);
    undo.push({ what: `trigger ${id}`, run: () => ctx.triggers.remove(id) });
  }
  const previous = plan.record;
  let teamId = null;
  if (plan.team) {
    teamId = plan.team.existingId ?? teams.get(plan.team.groupKey) ?? null;
    if (!teamId) {
      const made = (await ctx.agents.teams.create({ name: plan.team.name, color: plan.team.color })).id;
      teamId = made;
      teams.set(plan.team.groupKey, made);
      const groupKey = plan.team.groupKey;
      undo.unshift({
        what: `team ${plan.team.name}`,
        run: async () => {
          teams.delete(groupKey);
          await ctx.agents.teams.delete(made);
        }
      });
    }
    if (!creating && previous?.team !== void 0) {
      const before = previous.team;
      undo.push({ what: `team of ${name2}`, run: () => ctx.agents.update(name2, { team: before }) });
    }
    await ctx.agents.update(name2, { team: teamId });
  }
  const docs = {};
  for (const file of FINGERPRINTED_DOCS) docs[file] = fingerprint(await ctx.agents.docs.get(name2, file));
  const incoming = plan.source.sourceRef;
  const sourceRef = previous && previous.sourceRef !== incoming && (previous.aliases ?? []).includes(incoming) ? previous.sourceRef : incoming;
  const aliases = [.../* @__PURE__ */ new Set([
    ...previous?.aliases ?? [],
    ...previous ? [previous.sourceRef] : [],
    ...plan.aliases
  ])].filter((ref) => ref !== sourceRef).slice(-ALIASES_MAX);
  const record2 = {
    sourceApp,
    sourceRef,
    ...aliases.length ? { aliases } : {},
    // A superadmin's update leaves the record to the account that owns it.
    ownerUserId: previous && previous.ownerUserId !== void 0 ? previous.ownerUserId : plan.ownerUserId,
    agent: name2,
    docs,
    skills: plan.selected.skills ? skillIds : previous?.skills ?? [],
    mcpServers: plan.selected.mcp ? serverIds : previous?.mcpServers ?? [],
    triggers: plan.selected.routines ? triggerIds : previous?.triggers ?? [],
    rules: [.../* @__PURE__ */ new Set([...previous?.rules ?? [], ...ruleIds])],
    team: plan.team ? teamId : previous?.team ?? null,
    touched: false,
    importedAt: Date.now()
  };
  await records.put(record2, plan.recordKey);
  if (previous && plan.selected.routines) {
    for (const id of previous.triggers) {
      try {
        await ctx.triggers.remove(id);
      } catch (err2) {
        ctx.log.warn(`previous trigger ${id} could not be removed:`, errorText(err2));
        warnings.push("A routine of the previous import could not be removed: check the triggers of this agent.");
      }
    }
  }
}

// src/manifest.ts
var MANIFEST_FORMAT = "timon-agent-import";
var MANIFEST_VERSION = 1;
var MANIFEST_FILE = "timon-agent-import.json";
var SOURCE_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var SKILL_ID_RE = /^[a-z0-9._-]{1,100}$/;
var Key = string2().check(_regex(SOURCE_KEY_RE));
var SECRET_PATH_RE = /(^|\/)(\.env[^/]*|[^/]*\.env|[^/]*\.(pem|key|p12|pfx)|id_[a-z0-9_-]+(\.pub)?|auth\.json|credentials\.json)$/i;
function isSafeRelativePath(value) {
  if (value === "" || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  if (value.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return false;
  return !SECRET_PATH_RE.test(value);
}
var Rel = string2().check(_maxLength(300), refine(isSafeRelativePath, "unsafe relative path"));
var HHMM = string2().check(_regex(/^([01]\d|2[0-3]):[0-5]\d$/));
var WeekdaySchema = union([
  int().check(_gte(0), _lte(7)),
  _enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])
]);
var ScheduleSchema = discriminatedUnion("kind", [
  strictObject({ kind: literal("cron"), expression: string2().check(_minLength(1), _maxLength(200)) }),
  strictObject({ kind: literal("interval"), minutes: int().check(_gte(1), _lte(527040)) }),
  /** Kept for the preview, not applied in v1. */
  strictObject({ kind: literal("once"), at: iso_exports.datetime({ offset: true }) }),
  strictObject({ kind: literal("hourly"), minute: optional(int().check(_gte(0), _lte(59))) }),
  strictObject({ kind: literal("daily"), time: HHMM }),
  strictObject({ kind: literal("weekdays"), time: HHMM }),
  strictObject({ kind: literal("weekly"), days: array(WeekdaySchema).check(_minLength(1), _maxLength(7)), time: HHMM }),
  strictObject({ kind: literal("monthly"), day: int().check(_gte(1), _lte(31)), time: HHMM })
]);
var RoutineSchema = strictObject({
  name: string2().check(_minLength(1), _maxLength(80)),
  instruction: string2().check(_minLength(1), _maxLength(1e5)),
  schedule: ScheduleSchema,
  timezone: optional(nullable(string2().check(_maxLength(64)))),
  /** Imported routines start in the state they had at the source (the maintainer, 02/11/2026). */
  enabledInSource: boolean2()
});
var SkillSchema = strictObject({
  id: string2().check(_regex(SKILL_ID_RE)),
  /** The `SKILL.md` text. */
  content: string2().check(_minLength(1), _maxLength(1048576)),
  /** Files beside `SKILL.md` (references, scripts): not imported in v1, so the skill is not either. */
  companionFiles: optional(array(Rel).check(_maxLength(200))),
  hasCode: optional(boolean2())
});
var SecretNames = array(string2().check(_minLength(1), _maxLength(100))).check(_maxLength(64));
var McpServerSchema = strictObject({
  name: string2().check(_minLength(1), _maxLength(100)),
  transport: _enum(["http", "stdio"]),
  url: optional(string2().check(_maxLength(2048))),
  command: optional(string2().check(_maxLength(4096))),
  args: optional(array(string2().check(_maxLength(4096))).check(_maxLength(100))),
  /** Names of the headers or variables holding a secret: the values stay behind. */
  secretNames: optional(SecretNames)
});
var MemorySchema = strictObject({
  text: string2().check(_minLength(1), _maxLength(4e3)),
  kind: _enum(["preference", "decision", "pitfall"])
});
var DOC_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.md$/;
var DocSchema = strictObject({
  name: string2().check(_regex(DOC_NAME_RE), refine((n) => n.toLowerCase() !== "system-prompt.md", "the system prompt is `instructions`")),
  content: string2().check(_minLength(1), _maxLength(2e5))
});
var AvatarSchema = strictObject({
  mime: _enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataBase64: string2().check(_minLength(1), _maxLength(28e5), _regex(/^[A-Za-z0-9+/]+={0,2}$/))
});
var HintsSchema = strictObject({
  /**
   * The model at the source. Applied only with a `backend` that exists here
   * and lists it (another Timon); otherwise shown, never applied.
   */
  model: optional(string2().check(_maxLength(200))),
  /** A Timon backend name (`claude`, `codex`…): set by a Timon export only. */
  backend: optional(string2().check(_minLength(1), _maxLength(64))),
  /** The agent's role at the source, when it is a Timon role. */
  role: optional(string2().check(_minLength(1), _maxLength(32))),
  /** The project slug at the source; kept when the same project exists here. */
  project: optional(string2().check(_minLength(1), _maxLength(200))),
  /**
   * The working directory at the source, an absolute path of THAT machine
   * (any OS). Used when it exists here; otherwise the preview says so and
   * proposes a directory of this machine.
   */
  cwd: optional(string2().check(_minLength(1), _maxLength(4096))),
  /** It was the main agent at the source: informational, never re-seated here. */
  main: optional(boolean2()),
  /** Platforms the source delivered to (telegram, discord…): not carried over. */
  deliveries: optional(array(string2().check(_maxLength(100))).check(_maxLength(32))),
  /** Secrets the agent used at the source, by name: to enter again in the vault. */
  secretNames: optional(SecretNames),
  hasHistory: optional(boolean2())
});
var AgentSchema = strictObject({
  key: Key,
  displayName: string2().check(_minLength(1), _maxLength(100)),
  title: optional(string2().check(_maxLength(120))),
  /** Identity: becomes `SOUL.md`. */
  soul: optional(nullable(string2().check(_maxLength(2e5)))),
  /** Working instructions: become the system prompt. */
  instructions: optional(nullable(string2().check(_maxLength(2e5)))),
  /** Extra directives added after the role's (a Timon agent's `directives`). */
  directives: optional(nullable(string2().check(_maxLength(2e4)))),
  /**
   * Identity documents written as they are (`SOUL.md`, `USER.md`…): a
   * `SOUL.md` here is the agent's SOUL.md verbatim, instead of the one
   * composed from `displayName`, `title` and `soul`.
   */
  docs: optional(array(DocSchema).check(
    _maxLength(32),
    refine((docs) => new Set(docs.map((d) => d.name.toLowerCase())).size === docs.length, "two documents share a name")
  )),
  memories: optional(array(MemorySchema).check(_maxLength(256))),
  skills: optional(array(SkillSchema).check(_maxLength(200))),
  routines: optional(array(RoutineSchema).check(_maxLength(64))),
  mcpServers: optional(array(McpServerSchema).check(_maxLength(64))),
  avatar: optional(nullable(AvatarSchema)),
  hints: optional(HintsSchema),
  /** Stable identity at the source: the key of a re-import. */
  sourceRef: string2().check(_minLength(1), _maxLength(300))
});
var GroupSchema = strictObject({
  key: Key,
  name: string2().check(_minLength(1), _maxLength(160)),
  /** Agent `key`s of this manifest. */
  members: array(Key).check(_maxLength(100)),
  color: optional(nullable(string2().check(_maxLength(64))))
});
var AgentImportManifestSchema = strictObject({
  format: literal(MANIFEST_FORMAT),
  version: literal(MANIFEST_VERSION),
  source: strictObject({
    app: string2().check(_minLength(1), _maxLength(64)),
    exportedAt: optional(nullable(iso_exports.datetime({ offset: true })))
  }),
  agents: array(AgentSchema).check(
    _minLength(1),
    _maxLength(100),
    refine((agents) => new Set(agents.map((a) => a.key)).size === agents.length, "two agents share a key"),
    refine((agents) => new Set(agents.map((a) => a.sourceRef)).size === agents.length, "two agents share a sourceRef")
  ),
  groups: optional(array(GroupSchema).check(_maxLength(100))),
  /** What the adapter could not carry, in words for the user. */
  warnings: optional(array(string2().check(_maxLength(500))).check(_maxLength(200)))
});
var ManifestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
};
function parseManifest(value) {
  const parsed = AgentImportManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue2 = parsed.error.issues[0];
  const where = issue2?.path.length ? issue2.path.join(".") : "manifest";
  const what = issue2?.code === "unrecognized_keys" ? "unknown field" : issue2?.message ?? "invalid";
  throw new ManifestError(`Not a valid ${MANIFEST_FORMAT} v${MANIFEST_VERSION} manifest: ${where}: ${what}.`);
}
function parseManifestText(text) {
  let value;
  try {
    value = JSON.parse(text.charCodeAt(0) === 65279 ? text.slice(1) : text);
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} is not valid JSON.`);
  }
  return parseManifest(value);
}

// src/plan.ts
import { createHash as createHash2 } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// src/redact.ts
var SECRETISH = /(token|secret|passw|pwd|api[-_]?key|apikey|auth|credential|bearer|private[-_]?key|access[-_]?key|session|cookie|signature|^sig$)/i;
var BARE_TOKEN = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{12}|ya29\.|Bearer\s)/;
var REDACTED = "<redacted>";
var PATH_TOKEN_NAME = "URL path token";
var decoded = (segment) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
function sanitizeUrl(raw, secrets) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) {
    secrets.add("URL credentials");
    url.username = "";
    url.password = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRETISH.test(key)) {
      secrets.add(key);
      url.searchParams.delete(key);
    }
  }
  if (url.hash && SECRETISH.test(url.hash)) url.hash = "";
  const segments = url.pathname.split("/");
  if (segments.some((segment) => BARE_TOKEN.test(decoded(segment)))) {
    secrets.add(PATH_TOKEN_NAME);
    url.pathname = segments.map((segment) => BARE_TOKEN.test(decoded(segment)) ? REDACTED : segment).join("/");
  }
  return url.href;
}
function redactArgs(args, secrets) {
  const out = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z0-9][\w.-]*)(=)?/.exec(arg);
    if (flag) {
      if (SECRETISH.test(flag[1])) {
        secrets.add(flag[1].replace(/^-+/, ""));
        if (flag[2]) out.push(`${flag[1]}=${REDACTED}`);
        else {
          out.push(arg);
          hideNext = true;
        }
        continue;
      }
      out.push(arg);
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg);
    if (assignment && SECRETISH.test(assignment[1])) {
      secrets.add(assignment[1]);
      out.push(`${assignment[1]}=${REDACTED}`);
      continue;
    }
    if (BARE_TOKEN.test(arg)) {
      out.push(REDACTED);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      out.push(sanitizeUrl(arg, secrets) ?? REDACTED);
      continue;
    }
    out.push(arg);
  }
  return out;
}

// src/schedule-map.ts
var MIN_CADENCE_MINUTES = { trigger: 1, routine: 5 };
var MINUTES_PER_DAY = 1440;
var MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *"
};
var MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
var FULL_DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
var FIELDS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31, question: true, special: /^L$/i },
  { label: "month", min: 1, max: 12, names: Object.fromEntries(MONTH_NAMES.map((n, i) => [n, i + 1])) },
  {
    label: "day of week",
    min: 0,
    max: 7,
    question: true,
    names: Object.fromEntries(DAY_NAMES.map((n, i) => [n, i])),
    special: /^[0-7]L$|^[0-7]#[1-5]$/i
  }
];
var CronProblem = class extends Error {
};
function parseValue(raw, spec) {
  const named = spec.names?.[raw.toLowerCase()];
  if (named !== void 0) return named;
  if (!/^\d{1,2}$/.test(raw)) throw new CronProblem(`${spec.label}: "${raw}" is not a number`);
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw new CronProblem(`${spec.label}: ${value} is outside ${spec.min}\u2013${spec.max}`);
  }
  return value;
}
function parseField(field, spec) {
  const values = /* @__PURE__ */ new Set();
  for (const part of field.split(",")) {
    if (part === "") throw new CronProblem(`${spec.label}: empty list item`);
    if (spec.special?.test(part)) continue;
    const [base = "", stepRaw, extra] = part.split("/");
    if (extra !== void 0) throw new CronProblem(`${spec.label}: "${part}" has two steps`);
    let step = 1;
    if (stepRaw !== void 0) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) {
        throw new CronProblem(`${spec.label}: step "${stepRaw}" must be a positive number`);
      }
      step = Number(stepRaw);
    }
    let from;
    let to;
    if (base === "*" || base === "?" && spec.question === true) {
      from = spec.min;
      to = spec.max;
    } else if (base.includes("-")) {
      const [a = "", b = "", more] = base.split("-");
      if (more !== void 0) throw new CronProblem(`${spec.label}: "${base}" is not a range`);
      from = parseValue(a, spec);
      to = parseValue(b, spec);
      if (from > to) throw new CronProblem(`${spec.label}: range "${base}" runs backwards`);
    } else {
      from = parseValue(base, spec);
      to = stepRaw === void 0 ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}
function parseCron(expression) {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new CronProblem("the expression is empty");
  const lower2 = trimmed.toLowerCase();
  if (lower2.startsWith("@")) {
    const expanded = MACROS[lower2];
    if (expanded === void 0) throw new CronProblem(`"${trimmed}" is not a schedule Timon can run`);
    return parseCron(expanded);
  }
  const fields = trimmed.split(" ");
  if (fields.length === 6) {
    throw new CronProblem("six-field expressions (with seconds) are not supported");
  }
  if (fields.length !== 5) throw new CronProblem(`expected 5 fields, found ${fields.length}`);
  const sets = fields.map((f, i) => parseField(f, FIELDS[i]));
  const isAny = (i) => fields[i] === "*" || fields[i] === "?";
  return {
    cron: trimmed,
    minutes: [...sets[0]].sort((a, b) => a - b),
    hours: [...sets[1]].sort((a, b) => a - b),
    everyDay: isAny(2) && isAny(3) && isAny(4),
    everyHour: isAny(1)
  };
}
function shortestGap(minutes, hours) {
  const times = [];
  for (const h of hours) for (const m of minutes) times.push(h * 60 + m);
  times.sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  if (first === void 0 || last === void 0) return MINUTES_PER_DAY;
  let gap = first + MINUTES_PER_DAY - last;
  for (let i = 1; i < times.length; i += 1) gap = Math.min(gap, times[i] - times[i - 1]);
  return gap;
}
function parseTime(time3) {
  const match = typeof time3 === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time3.trim()) : null;
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) throw new CronProblem(`time "${String(time3)}" is not a 24-hour HH:MM`);
  return { hour, minute };
}
function weekdayNumber(day) {
  if (typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 7) return day % 7;
  if (typeof day === "string") {
    const name2 = day.trim().toLowerCase();
    const index = DAY_NAMES.findIndex((short, i) => name2 === short || name2 === FULL_DAY_NAMES[i]);
    if (index >= 0) return index;
  }
  throw new CronProblem(`"${String(day)}" is not a day of the week`);
}
function intervalToCron(minutes) {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) {
    throw new CronProblem(`interval "${String(minutes)}" is not a whole number of minutes`);
  }
  if (minutes < 60 && 60 % minutes === 0) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
  if (minutes % 60 === 0 && 24 % (minutes / 60) === 0) {
    const hours = minutes / 60;
    if (hours === 1) return "0 * * * *";
    if (hours === 24) return "0 0 * * *";
    return `0 */${hours} * * *`;
  }
  throw new CronProblem(
    `every ${minutes} minutes has no cron equivalent: only intervals that divide an hour or a day evenly can be imported`
  );
}
function sourceToCron(schedule, warnings) {
  switch (schedule.kind) {
    case "cron":
      if (typeof schedule.expression !== "string") throw new CronProblem("the expression is missing");
      return schedule.expression;
    case "interval":
      return intervalToCron(schedule.minutes);
    case "hourly": {
      const minute = schedule.minute ?? 0;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new CronProblem(`minute "${String(minute)}" is outside 0\u201359`);
      }
      return `${minute} * * * *`;
    }
    case "daily": {
      const { hour, minute } = parseTime(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekdays": {
      const { hour, minute } = parseTime(schedule.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case "weekly": {
      const { hour, minute } = parseTime(schedule.time);
      if (!Array.isArray(schedule.days) || schedule.days.length === 0) throw new CronProblem("no day of the week given");
      const days = [...new Set(schedule.days.map(weekdayNumber))].sort((a, b) => a - b);
      return `${minute} ${hour} * * ${days.join(",")}`;
    }
    case "monthly": {
      const { hour, minute } = parseTime(schedule.time);
      const { day } = schedule;
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new CronProblem(`day of month "${String(day)}" is outside 1\u201331`);
      if (day > 28) warnings.push(`Runs on day ${day} only in the months that have one.`);
      return `${minute} ${hour} ${day} * *`;
    }
    default:
      throw new CronProblem(`unknown schedule kind "${String(schedule.kind)}"`);
  }
}
function canonicalTimeZone(raw) {
  const name2 = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name2) || name2.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name2 }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
function resolveTimeZone(raw, sensitive, warnings) {
  if (raw === null || raw === void 0 || typeof raw === "string" && raw.trim() === "") {
    if (sensitive) warnings.push("No time zone in the source: it runs in the time zone of the machine Timon runs on.");
    return null;
  }
  const tz = typeof raw === "string" ? canonicalTimeZone(raw) : null;
  if (tz === null) {
    warnings.push(`Unknown time zone "${String(raw)}": it runs in the time zone of the machine Timon runs on.`);
  }
  return tz;
}
function mapSchedule(input, target = "trigger") {
  const enabled = input.enabledInSource === true;
  const warnings = [];
  const { schedule } = input;
  const kind = schedule?.kind;
  if (typeof schedule !== "object" || schedule === null) {
    return { skipped: true, reason: 'Invalid schedule: unknown schedule kind "none".', enabled, warnings };
  }
  if (kind === "once") {
    const at = schedule.at;
    const time3 = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(time3)) return { skipped: true, reason: `one-off run at "${String(at)}" is not a valid date`, enabled, warnings };
    return {
      skipped: true,
      reason: "One-off runs are not imported yet: shown here so it can be recreated by hand.",
      enabled,
      onceAt: new Date(time3).toISOString(),
      warnings
    };
  }
  let parsed;
  try {
    parsed = parseCron(sourceToCron(schedule, warnings));
  } catch (err2) {
    if (!(err2 instanceof CronProblem)) throw err2;
    return { skipped: true, reason: `Invalid schedule: ${err2.message}.`, enabled, warnings };
  }
  const floor = MIN_CADENCE_MINUTES[target];
  const gap = shortestGap(parsed.minutes, parsed.hours);
  if (gap < floor) {
    return {
      skipped: true,
      reason: `Runs every ${gap} minute${gap === 1 ? "" : "s"}; Timon runs a routine at most every ${floor} minute${floor === 1 ? "" : "s"}.`,
      enabled,
      warnings
    };
  }
  const sensitive = !(parsed.everyHour && parsed.everyDay);
  const tz = target === "routine" ? null : resolveTimeZone(input.timezone, sensitive, warnings);
  if (target === "routine" && sensitive && input.timezone) {
    warnings.push(`Time zone "${String(input.timezone)}" dropped: it runs in the time zone of the machine Timon runs on.`);
  }
  return { skipped: false, cron: parsed.cron, tz, enabled, warnings };
}

// src/skill-text.ts
var KEY_RE = /^\s*allowed[-_]tools\s*:/i;
var CONTINUATION_RE = /^(\s+\S|\s*-\s)/;
function dropKey(lines) {
  const out = [];
  let removed = false;
  let skipping = false;
  for (const line of lines) {
    if (KEY_RE.test(line)) {
      removed = true;
      skipping = true;
      continue;
    }
    if (skipping && CONTINUATION_RE.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return { lines: out, removed };
}
function stripAllowedTools(content) {
  if (!/^\s*---/.test(content)) return { content, removed: false };
  const lines = content.split(/\r?\n/);
  const open5 = lines.findIndex((line) => line.trim() === "---");
  const close = open5 < 0 ? -1 : lines.findIndex((line, i) => i > open5 && line.trim() === "---");
  if (open5 < 0 || close < 0) {
    const all = dropKey(lines);
    return { content: all.lines.join("\n"), removed: all.removed };
  }
  const head = dropKey(lines.slice(open5 + 1, close));
  const rest = lines.slice(close);
  const tail = dropKey(rest.slice(1));
  const removed = head.removed || tail.removed;
  if (!removed) return { content, removed: false };
  return { content: [...lines.slice(0, open5 + 1), ...head.lines, rest[0], ...tail.lines].join("\n"), removed };
}

// src/source-ref.ts
var EXPORT_SOURCE_APP = "timon";
var SOURCE_REF_MAX = 300;
var STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var STABLE_REF_RE = /^timon:([a-f0-9]{16}):id:([0-9a-f-]{36})$/;
function legacySourceRef(instance, name2) {
  return `timon:${instance}:${name2.toLowerCase()}`.slice(0, SOURCE_REF_MAX);
}
function exportSourceRef(instance, agent) {
  if (typeof agent.id === "string" && STABLE_ID_RE.test(agent.id)) return `timon:${instance}:id:${agent.id}`;
  return legacySourceRef(instance, agent.name);
}
function sourceRefAliases(sourceApp, agent) {
  if (sourceApp !== EXPORT_SOURCE_APP) return [];
  const match = STABLE_REF_RE.exec(agent.sourceRef);
  if (!match || !STABLE_ID_RE.test(match[2])) return [];
  return [legacySourceRef(match[1], agent.displayName)];
}

// src/plan.ts
var MEMORY_RULES_PER_AGENT = 64;
var ROUTINE_PROMPT_MAX = 2e4;
var AVATAR_MAX_BYTES = 2 * 1024 * 1024;
var AGENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]*$/u;
var AGENT_NAME_MAX_BYTES = 80;
var WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;
var utf8Bytes = (value) => new TextEncoder().encode(value).length;
var validAgentName = (name2) => AGENT_NAME_RE.test(name2) && utf8Bytes(name2) <= AGENT_NAME_MAX_BYTES && !name2.endsWith(".") && !WINDOWS_RESERVED_RE.test(name2.split(".")[0] ?? "");
var clipAgentName = (value, max2) => {
  let out = "";
  for (const char of value) {
    if (utf8Bytes(out + char) > max2) break;
    out += char;
  }
  return out.replace(/[.-]+$/, "");
};
var agentWithSuffix = (base, n) => {
  if (n === 1) return base;
  const tail = `-${n}`;
  return clipAgentName(base, AGENT_NAME_MAX_BYTES - tail.length) + tail;
};
var PREFIX_MAX = 30;
var SUFFIX_TRIES = 50;
var sha = (text) => createHash2("sha256").update(text).digest("hex");
var lower = (s) => s.toLowerCase();
function slugPrefix(app) {
  const slug = app.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, PREFIX_MAX).replace(/-$/, "");
  return slug || "import";
}
function serverSlug(name2) {
  const slug = name2.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 90).replace(/[-.]+$/, "");
  return slug || "mcp";
}
var withSuffix = (base, n, max2) => {
  if (n === 1) return base;
  const tail = `-${n}`;
  return base.slice(0, max2 - tail.length) + tail;
};
function isLocalUrl(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}
function avatarOk(mime, data) {
  if (Math.floor(data.length * 3 / 4) > AVATAR_MAX_BYTES + 3) return false;
  const head = Buffer.from(data.slice(0, 24), "base64");
  switch (mime) {
    case "image/png":
      return head.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]));
    case "image/jpeg":
      return head[0] === 255 && head[1] === 216 && head[2] === 255;
    case "image/gif":
      return head.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp":
      return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
}
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function segmentsOf(path) {
  return path.split(/[\\/]+/).filter((s) => s !== "" && s !== "." && s !== ".." && !/^[A-Za-z]:$/.test(s));
}
var CWD_TAIL_MAX = 4;
function suggestCwd(sourceCwd, home = homedir(), exists2 = isDirectory) {
  const segments = segmentsOf(sourceCwd);
  for (let n = Math.min(segments.length - 1, CWD_TAIL_MAX); n >= 1; n -= 1) {
    const candidate = join(home, ...segments.slice(-n));
    if (exists2(candidate)) return candidate;
  }
  return null;
}
function soulOf(agent) {
  const parts = [`# ${agent.displayName}`];
  if (agent.title) parts.push(`*${agent.title}*`);
  if (agent.soul && agent.soul.trim()) parts.push(agent.soul.trim());
  return `${parts.join("\n\n")}
`;
}
var COMMAND_LINE_MAX = 200;
function commandLine(command, args, secrets) {
  const program = command ? redactArgs([command.split(/[\\/]/).pop() ?? command], secrets)[0] ?? "" : "";
  return [program, ...redactArgs(args ?? [], secrets)].join(" ").trim().slice(0, COMMAND_LINE_MAX);
}
var listOf = (names) => names.slice(0, 20).join(", ") + (names.length > 20 ? ", \u2026" : "");
async function planImport(ctx, records, manifest, options = {}) {
  const sourceApp = manifest.source.app;
  const origin = `plugin:${ctx.id}`;
  const superadmin = ctx.user()?.is_superadmin === true;
  const caller = { userId: ctx.user()?.id ?? null, superadmin };
  const holds = (permission) => {
    try {
      ctx.assertPermission(permission);
      return true;
    } catch {
      return false;
    }
  };
  const may = {
    skills: holds("skills:manage"),
    mcp: holds("mcp:manage"),
    routines: holds("triggers:manage") && holds("kanban:write")
  };
  const warnings = [...manifest.warnings ?? []];
  if (!may.skills) warnings.push("Your account may not write skills: the skills are left out.");
  if (!may.mcp) warnings.push("Your account may not declare MCP servers: they are left out.");
  if (!may.routines) warnings.push("Your account may not create triggers and tasks: the routines are left out.");
  const agents = await ctx.agents.list();
  const byName = new Map(agents.map((a) => [lower(a.name), a]));
  const skills = new Map((await ctx.skills.list()).map((s) => [s.id, s]));
  const servers = new Map((await ctx.mcpServers.list()).map((s) => [s.id, s]));
  const teams = await ctx.agents.teams.list();
  let catalog = null;
  if (manifest.agents.some((a) => a.hints?.backend)) {
    try {
      catalog = await ctx.backends.list();
    } catch {
      warnings.push("The backends of this Timon could not be read: imported agents use the default backend and model.");
    }
  }
  let prefix = options.prefix ?? slugPrefix(sourceApp);
  if (options.prefix === void 0) {
    const foreign = agents.some((a) => lower(a.name).startsWith(`${prefix}.`) && a.createdBy !== origin);
    if (foreign) {
      warnings.push(`Names starting with "${prefix}." are already used by other agents: imported agents are named "import.<name>".`);
      prefix = "import";
    }
  }
  const choices = new Map((options.agents ?? []).map((c) => [c.sourceRef, c]));
  const taken = new Set(byName.keys());
  const claimedSkills = /* @__PURE__ */ new Map();
  const runSkills = /* @__PURE__ */ new Map();
  const claimedServers = /* @__PURE__ */ new Set();
  const runServers = /* @__PURE__ */ new Map();
  const groupsOf = /* @__PURE__ */ new Map();
  for (const group of manifest.groups ?? []) {
    for (const key of new Set(group.members)) groupsOf.set(key, [...groupsOf.get(key) ?? [], group]);
  }
  const skillId = async (sourceId, content) => {
    const sameRun = runSkills.get(`${sourceId}\0${sha(content)}`);
    if (sameRun) return sameRun;
    for (let n = 1; n <= SUFFIX_TRIES; n += 1) {
      const id = withSuffix(sourceId, n, 100);
      if (claimedSkills.has(id)) continue;
      const existing = skills.get(id);
      if (existing) {
        const owner = existing.mine ? await records.skill(id) : null;
        if (!owner || !ownedBy(owner.ownerUserId, caller) || owner.sourceApp !== sourceApp || owner.sourceId !== sourceId) continue;
      }
      claimedSkills.set(id, sourceId);
      runSkills.set(`${sourceId}\0${sha(content)}`, id);
      return id;
    }
    return null;
  };
  const serverId = async (name2) => {
    const sameRun = runServers.get(name2);
    if (sameRun) return sameRun;
    const base = serverSlug(name2);
    for (let n = 1; n <= SUFFIX_TRIES; n += 1) {
      const id = withSuffix(base, n, 100);
      if (claimedServers.has(id)) continue;
      const existing = servers.get(id);
      if (existing) {
        const owner = existing.mine ? await records.mcp(id) : null;
        if (!owner || !ownedBy(owner.ownerUserId, caller) || owner.sourceApp !== sourceApp || owner.sourceId !== name2) continue;
      }
      claimedServers.add(id);
      runServers.set(name2, id);
      return id;
    }
    return null;
  };
  const changedByHand = async (record2) => {
    if (record2.touched) return true;
    for (const file of FINGERPRINTED_DOCS) {
      if (!(file in record2.docs)) continue;
      const now = fingerprint(await ctx.agents.docs.get(record2.agent, file));
      if (now !== record2.docs[file]) return true;
    }
    return false;
  };
  const plans = [];
  const extra = /* @__PURE__ */ new Map();
  for (const source of manifest.agents) {
    const choice = choices.get(source.sourceRef);
    const notes = [];
    const aliases = sourceRefAliases(sourceApp, source);
    const found = await records.find(sourceApp, source.sourceRef, caller, aliases);
    const record2 = found?.record ?? null;
    const current = record2 ? byName.get(lower(record2.agent)) : void 0;
    const previous = record2 && current && current.mine ? record2 : null;
    let action = previous ? "update" : "create";
    let finalName = previous ? current.name : "";
    if (!previous) {
      let base = clipAgentName(`${prefix}.${source.key}`, AGENT_NAME_MAX_BYTES);
      if (choice?.name !== void 0) {
        const chosen = choice.name.normalize("NFC");
        if (validAgentName(chosen)) base = chosen;
        else notes.push(`"${choice.name.slice(0, 100)}" is not a valid agent name: ${base} is used instead.`);
      }
      for (let n = 1; n <= SUFFIX_TRIES && !finalName; n += 1) {
        const candidate = agentWithSuffix(base, n);
        if (!taken.has(lower(candidate))) finalName = candidate;
      }
      if (!finalName) {
        action = "skip";
        finalName = base;
        notes.push("No free name was found for this agent.");
      } else if (lower(finalName) !== lower(base)) {
        notes.push(`${base} is taken: the agent is named ${finalName}.`);
      }
    } else if (choice?.name !== void 0 && choice.name !== finalName) {
      notes.push(`Already imported as ${finalName}: the name stays.`);
    }
    if (action !== "skip") taken.add(lower(finalName));
    if (choice?.include === false) {
      action = "skip";
      notes.push("Left out.");
    } else if (previous && await changedByHand(previous)) {
      action = "skip";
      notes.push(`${finalName} was changed by hand since it was imported: it is not overwritten. Rename or delete it to import it again.`);
    }
    const hints = source.hints ?? {};
    const setRole = !previous || choice?.role !== void 0;
    const roleFromSource = choice?.role === void 0 && !previous && hints.role !== void 0;
    let role = choice?.role ?? (previous ? current.role ?? DEFAULT_IMPORT_ROLE : hints.role ?? DEFAULT_IMPORT_ROLE);
    if (setRole && role === "orchestrator" && !superadmin) {
      notes.push(`Only a superadmin may import an orchestrator: the role is ${DEFAULT_IMPORT_ROLE}.`);
      role = DEFAULT_IMPORT_ROLE;
    }
    if (hints.main) notes.push("This was the main agent at the source: it is imported as an ordinary agent, the main agent here stays the same.");
    const projectFromSource = choice?.project === void 0 && !previous && hints.project !== void 0;
    const project = projectFromSource ? hints.project : choice?.project;
    const sourceCwd = hints.cwd ?? null;
    let cwd = choice?.cwd ?? null;
    let cwdFromSource = false;
    let cwdSuggestion = null;
    if (choice?.cwd === void 0 && sourceCwd !== null) {
      if (isAbsolute(sourceCwd) && isDirectory(sourceCwd)) {
        cwd = sourceCwd;
        cwdFromSource = true;
      } else {
        cwdSuggestion = suggestCwd(sourceCwd);
        notes.push(cwdSuggestion ? `The working directory at the source (${sourceCwd.slice(0, 300)}) does not exist on this machine: ${cwdSuggestion} looks like it, choose it to use it. Until then the agent has no working directory.` : `The working directory at the source (${sourceCwd.slice(0, 300)}) does not exist on this machine: the agent has no working directory until you choose one.`);
      }
    }
    const cwdMissing = cwd !== null && !isDirectory(cwd);
    if (cwdMissing) notes.push("The chosen working directory does not exist: the agent is created without it.");
    let backend = null;
    let model = null;
    let backendMissing = false;
    let modelMissing = false;
    if (hints.backend !== void 0 && catalog) {
      const wanted = hints.backend;
      const entry = catalog.backends.find((b) => b.id === wanted) ?? catalog.backends.find((b) => b.id === wanted.split("@")[0]);
      if (!entry) {
        backendMissing = true;
        notes.push(`Backend ${wanted} is not available here: the agent uses the default backend and model.`);
      } else {
        backend = entry.id;
        if (entry.id !== wanted) notes.push(`Backend ${wanted} is an account of the source machine: the agent uses ${entry.id}.`);
        if (hints.model !== void 0) {
          const offered = entry.models.some((m) => m.slug === hints.model) || (entry.slugPrefixes ?? []).some((p) => hints.model.startsWith(p));
          if (offered) model = hints.model;
          else {
            modelMissing = true;
            notes.push(`Model ${hints.model} is not offered by ${entry.id} here: the agent uses its default model.`);
          }
        }
      }
    } else if (hints.backend === void 0 && hints.model) {
      notes.push(`The model at the source (${hints.model}) is not carried over: the agent uses Timon's default.`);
    }
    const wants = (element) => choice?.elements?.[element] ?? true;
    const skillPlans = [];
    for (const skill of source.skills ?? []) {
      if ((skill.companionFiles?.length ?? 0) > 0 || skill.hasCode === true) {
        notes.push(`Skill ${skill.id} comes with files or scripts: not imported.`);
        continue;
      }
      const stripped = stripAllowedTools(skill.content);
      if (stripped.removed) notes.push(`Skill ${skill.id}: its pre-authorised tools (allowed-tools) are removed.`);
      if (!stripped.content.trim()) continue;
      if (!may.skills || !wants("skills") || action === "skip") {
        skillPlans.push({ sourceId: skill.id, finalId: skill.id, content: stripped.content });
        continue;
      }
      const id = await skillId(skill.id, stripped.content);
      if (!id) {
        notes.push(`Skill ${skill.id}: no free id was found, not imported.`);
        continue;
      }
      if (id !== skill.id) notes.push(`Skill ${skill.id} is imported as ${id}: the id is taken.`);
      skillPlans.push({ sourceId: skill.id, finalId: id, content: stripped.content });
    }
    const mcpPlans = [];
    const secretNames = new Set(source.hints?.secretNames ?? []);
    for (const server of source.mcpServers ?? []) {
      for (const name2 of server.secretNames ?? []) secretNames.add(name2);
      if (server.transport === "stdio") {
        const line = commandLine(server.command, server.args, secretNames);
        notes.push(`MCP server ${server.name} runs a command on this machine${line ? ` (${line})` : ""}: not created. Add it by hand from the MCP servers page if you trust it.`);
        continue;
      }
      let url = null;
      try {
        url = server.url ? new URL(server.url) : null;
      } catch {
        url = null;
      }
      if (!url || url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) {
        notes.push(`MCP server ${server.name} has no usable http(s) address: not created.`);
        continue;
      }
      const found2 = /* @__PURE__ */ new Set();
      url = new URL(sanitizeUrl(url.href, found2) ?? url.href);
      if (found2.size > 0) {
        for (const name2 of found2) secretNames.add(name2);
        notes.push(`MCP server ${server.name}: its address carried a secret (${listOf([...found2])}), removed. Enter it again once the server is created.`);
      }
      if (isLocalUrl(url)) {
        notes.push(`MCP server ${server.name} points at a local or private address: not created.`);
        continue;
      }
      if (!may.mcp || !wants("mcp") || action === "skip") {
        mcpPlans.push({ name: server.name, finalId: serverSlug(server.name), url: url.href });
        continue;
      }
      const id = await serverId(server.name);
      if (!id) {
        notes.push(`MCP server ${server.name}: no free id was found, not created.`);
        continue;
      }
      mcpPlans.push({ name: server.name, finalId: id, url: url.href });
    }
    if (secretNames.size > 0) notes.push(`Secrets to enter again in the vault: ${listOf([...secretNames])}.`);
    const memories = (source.memories ?? []).slice(0, MEMORY_RULES_PER_AGENT);
    const dropped = (source.memories?.length ?? 0) - memories.length;
    if (dropped > 0) notes.push(`${dropped} memories over the limit of ${MEMORY_RULES_PER_AGENT} per agent are not imported.`);
    const routinePlans = [];
    let activeRoutines = 0;
    const keepActive = choice?.keepRoutinesActive === true;
    for (const routine of source.routines ?? []) {
      const mapped = mapSchedule({
        schedule: routine.schedule,
        timezone: routine.timezone ?? null,
        enabledInSource: routine.enabledInSource
      }, "trigger");
      if (mapped.skipped) {
        notes.push(`Routine "${routine.name}": ${mapped.reason}`);
        continue;
      }
      for (const warning of mapped.warnings) notes.push(`Routine "${routine.name}": ${warning}`);
      if (routine.instruction.length > ROUTINE_PROMPT_MAX) {
        notes.push(`Routine "${routine.name}": its instruction is longer than ${ROUTINE_PROMPT_MAX} characters, not imported.`);
        continue;
      }
      if (mapped.enabled) activeRoutines += 1;
      routinePlans.push({ name: routine.name, instruction: routine.instruction, cron: mapped.cron, tz: mapped.tz, enabled: mapped.enabled && keepActive });
    }
    if (activeRoutines > 0 && !keepActive) {
      notes.push(`${activeRoutines} routine(s) switched on at the source are imported switched off: choose to keep them active to have them run.`);
    }
    let team = null;
    const groups = groupsOf.get(source.key) ?? [];
    if (groups[0]) {
      const group = groups[0];
      const existing = teams.find((t) => lower(t.name) === lower(group.name));
      team = { groupKey: group.key, name: group.name, color: group.color ?? null, existingId: existing?.id ?? null };
      if (groups.length > 1) notes.push(`An agent belongs to one team: ${group.name} is kept, not ${listOf(groups.slice(1).map((g) => g.name))}.`);
    }
    let avatar = null;
    if (source.avatar) {
      if (avatarOk(source.avatar.mime, source.avatar.dataBase64)) avatar = { mime: source.avatar.mime, data: source.avatar.dataBase64 };
      else notes.push("The picture is not a valid image of its type, or is too large: not imported.");
    }
    const deliveries = source.hints?.deliveries ?? [];
    if (deliveries.length > 0) notes.push(`Deliveries are not carried over: ${listOf(deliveries)}.`);
    if (source.hints?.hasHistory) notes.push("The conversation history is not imported.");
    const soulDoc = (source.docs ?? []).find((d) => d.name.toLowerCase() === "soul.md");
    const otherDocs = (source.docs ?? []).filter((d) => d !== soulDoc).map((d) => ({ name: d.name, content: d.content }));
    const counts = {
      soul: 1,
      memory: memories.length,
      skills: skillPlans.length,
      mcp: mcpPlans.length,
      routines: routinePlans.length,
      team: team ? 1 : 0
    };
    const allowed = {
      soul: true,
      memory: true,
      skills: may.skills,
      mcp: may.mcp,
      routines: may.routines,
      team: true
    };
    const selected = Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, action !== "skip" && allowed[e] && wants(e) && counts[e] > 0]));
    const agentPlan = {
      source,
      action,
      finalName,
      role,
      setRole,
      project,
      cwd: cwdMissing ? null : cwd,
      record: previous,
      recordKey: previous ? found?.key ?? null : null,
      aliases,
      ownerUserId: caller.userId,
      backend,
      model,
      fromSource: { role: roleFromSource, project: projectFromSource, cwd: cwdFromSource },
      systemPrompt: source.instructions ?? "",
      directives: source.directives ?? null,
      soul: selected.soul ? soulDoc?.content ?? soulOf(source) : null,
      docs: selected.soul ? otherDocs : [],
      avatar,
      selected,
      skills: selected.skills ? skillPlans : [],
      mcp: selected.mcp ? mcpPlans : [],
      memories: selected.memory ? memories : [],
      routines: selected.routines ? routinePlans : [],
      team: selected.team ? team : null,
      counts,
      warnings: notes
    };
    plans.push(agentPlan);
    extra.set(agentPlan, { cwdSuggestion, backendMissing, modelMissing, activeRoutines });
  }
  const preview = {
    source: { app: sourceApp, exportedAt: manifest.source.exportedAt ?? null },
    warnings,
    agents: plans.map((p) => {
      const elements = Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, { count: p.counts[e], selected: p.selected[e] }]));
      const choice = choices.get(p.source.sourceRef);
      return {
        sourceRef: p.source.sourceRef,
        displayName: p.source.displayName,
        action: p.action,
        warnings: p.warnings,
        finalName: p.finalName,
        role: p.role,
        project: p.project ?? null,
        cwd: choice?.cwd ?? p.cwd,
        cwdMissing: (choice?.cwd ?? null) !== null && p.cwd === null,
        sourceCwd: p.source.hints?.cwd ?? null,
        cwdSuggestion: extra.get(p)?.cwdSuggestion ?? null,
        backend: p.backend,
        model: p.model,
        backendMissing: extra.get(p)?.backendMissing ?? false,
        modelMissing: extra.get(p)?.modelMissing ?? false,
        activeRoutines: extra.get(p)?.activeRoutines ?? 0,
        elements
      };
    })
  };
  return { sourceApp, agents: plans, warnings, preview };
}

// src/readers/policy.ts
var ReaderError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReaderError";
  }
  code;
};
var DENIED_SEGMENTS = [
  // `.env`, `.env.local`, `.envrc`, `.env_prod`, `prod.env`: any name starting
  // with `.env` is treated as a secret store, at the cost of a rare false positive.
  /^\.env/i,
  /\.env$/i,
  /^auth\.json$/i,
  /^credentials\.json$/i,
  // Hermes / CLI credentials
  /^state\.db(-wal|-shm|-journal)?$/i,
  // Hermes state database and its journals
  /\.(pem|key|p12|pfx)$/i,
  // certificates and private keys
  // SSH keys (`id_rsa`, `id_ed25519.pub`). An extension other than `.pub`
  // means an ordinary file (`id_mapping.md`), which stays readable.
  /^id_[a-z0-9_-]+(\.pub)?$/i,
  /^\.git$/i,
  /^node_modules$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
  // Not secrets but OS bookkeeping a Finder or Explorer zip carries: AppleDouble
  // copies (`__MACOSX/…/._SKILL.md`) would otherwise reach an adapter asking for `**`.
  /^__MACOSX$/,
  /^\._/,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i
];
var NESTED_ARCHIVE = /\.(zip|tar|tgz|tbz2?|txz|gz|bz2|xz|zst|7z|rar|jar)$/i;
function isDeniedSegment(segment) {
  return DENIED_SEGMENTS.some((re) => re.test(segment));
}
function isNestedArchive(fileName) {
  return NESTED_ARCHIVE.test(fileName);
}
function deniedPrefix(segments) {
  for (let i = 0; i < segments.length; i++) {
    if (isDeniedSegment(segments[i] ?? "")) return segments.slice(0, i + 1).join("/");
  }
  return null;
}
var WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
function isUnportableSegment(segment) {
  if (segment === "" || segment === "." || segment === "..") return true;
  if (/[<>:"|?*\\\u0000-\u001f]/.test(segment)) return true;
  if (segment.endsWith(".") || segment.endsWith(" ")) return true;
  return WINDOWS_RESERVED.test(segment);
}
function archiveEntrySegments(raw) {
  if (raw.includes("\0")) throw new ReaderError("unsafe-path", "archive entry name contains a NUL byte");
  const name2 = raw.replaceAll("\\", "/");
  if (name2.startsWith("/") || /^[a-zA-Z]:/.test(name2)) {
    throw new ReaderError("unsafe-path", `archive entry ${JSON.stringify(raw)} has an absolute path`);
  }
  const parts = name2.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new ReaderError("unsafe-path", `archive entry ${JSON.stringify(raw)} escapes the archive (\`..\`)`);
  }
  return parts.map((part) => part.normalize("NFC"));
}
function segmentRegExp(segment) {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "u");
}
function compileGlob(pattern) {
  const parts = pattern.split("/").filter((part) => part !== "" && part !== ".");
  if (pattern.startsWith("/") || pattern.includes("\\") || parts.includes("..") || parts.length === 0) {
    throw new ReaderError("unsafe-path", `invalid wants pattern ${JSON.stringify(pattern)}`);
  }
  return {
    source: pattern,
    segments: parts.map((part) => part === "**" ? "**" : segmentRegExp(part.normalize("NFC")))
  };
}
function matchFrom(glob, gi, path, pi) {
  if (gi === glob.length) return pi === path.length;
  const g = glob[gi];
  if (g === "**") {
    for (let skip = pi; skip <= path.length; skip++) {
      if (matchFrom(glob, gi + 1, path, skip)) return true;
    }
    return false;
  }
  const seg = path[pi];
  if (seg === void 0 || g === void 0 || !g.test(seg)) return false;
  return matchFrom(glob, gi + 1, path, pi + 1);
}
function globMatches(glob, segments) {
  return matchFrom(glob.segments, 0, segments, 0);
}
function globMayMatchBelow(glob, dirSegments) {
  let gi = 0;
  for (const seg of dirSegments) {
    const g = glob.segments[gi];
    if (g === "**") return true;
    if (g === void 0 || !g.test(seg)) return false;
    gi++;
  }
  return gi < glob.segments.length;
}
function compileWants(wants) {
  if (wants.length === 0) throw new ReaderError("unsafe-path", "an adapter must declare at least one wants pattern");
  return wants.map(compileGlob);
}
var SKILL_FILE = "skill.md";
function parentOf(path) {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
function planSelection(candidates, limits) {
  const skipped = [];
  const sorted = [...candidates].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let kept = [];
  for (const c of sorted) {
    if (c.size > limits.maxFileBytes) skipped.push({ path: c.path, reason: "too-large" });
    else kept.push(c);
  }
  const byKey = /* @__PURE__ */ new Map();
  for (const c of kept) {
    const key = c.path.toLowerCase();
    const group = byKey.get(key);
    if (group) group.push(c);
    else byKey.set(key, [c]);
  }
  const colliding = /* @__PURE__ */ new Set();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const c of group) {
      colliding.add(c);
      skipped.push({ path: c.path, reason: "case-collision" });
    }
  }
  kept = kept.filter((c) => !colliding.has(c));
  const skillDirs = new Set(
    kept.filter((c) => (c.path.split("/").pop() ?? "").toLowerCase() === SKILL_FILE).map((c) => parentOf(c.path))
  );
  if (skillDirs.size > 0) {
    const owner = (path) => {
      for (let dir = parentOf(path); ; dir = parentOf(dir)) {
        if (skillDirs.has(dir)) return dir;
        if (dir === "") return null;
      }
    };
    const usage = /* @__PURE__ */ new Map();
    const owners = /* @__PURE__ */ new Map();
    for (const c of kept) {
      const dir = owner(c.path);
      if (dir === null) continue;
      owners.set(c, dir);
      const u = usage.get(dir) ?? { bytes: 0, files: 0 };
      u.bytes += c.size;
      u.files += 1;
      usage.set(dir, u);
    }
    const oversized = /* @__PURE__ */ new Set();
    for (const [dir, u] of usage) {
      if (u.bytes > limits.maxSkillBytes || u.files > limits.maxSkillFiles) {
        oversized.add(dir);
        skipped.push({ path: dir === "" ? "." : dir, reason: "skill-too-large" });
      }
    }
    if (oversized.size > 0) kept = kept.filter((c) => !oversized.has(owners.get(c) ?? "\0"));
  }
  if (kept.length > limits.maxFiles) {
    throw new ReaderError("too-many-files", `the source holds more than ${limits.maxFiles} importable files`);
  }
  const total = kept.reduce((sum, c) => sum + c.size, 0);
  if (total > limits.maxBytes) {
    throw new ReaderError("too-large", `the source holds more than ${limits.maxBytes} bytes of importable files`);
  }
  return { keep: kept, skipped };
}

// src/readers/zip.ts
import { open } from "node:fs/promises";

// node_modules/fflate/esm/index.mjs
import { createRequire } from "node:module";
var require2 = createRequire("/");
var _a2;
var Worker;
var isMarkedAsUntransferable;
try {
  _a2 = require2("worker_threads"), Worker = _a2.Worker, isMarkedAsUntransferable = _a2.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a2 = freb(fleb, 2);
var fl = _a2.b;
var revfl = _a2.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a3 = hTree(lf, 15), dlt = _a3.t, mlb = _a3.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (var i = 0; i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    var sym = syms[i];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i + 2 < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi); i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (var i = st.w || 0; i < s + lst; i += 65535) {
      var e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i = 0; i < 256; ++i) {
    var c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i = 0; i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var Inflate = /* @__PURE__ */ (function() {
  function Inflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
    this.s = { i: 0, b: dict ? dict.length : 0 };
    this.o = new u8(32768);
    this.p = new u8(0);
    if (dict)
      this.o.set(dict);
  }
  Inflate2.prototype.e = function(c) {
    if (!this.ondata)
      err(5);
    if (this.d)
      err(4);
    if (!this.p.length)
      this.p = c;
    else if (c.length) {
      var n = new u8(this.p.length + c.length);
      n.set(this.p), n.set(c, this.p.length), this.p = n;
    }
  };
  Inflate2.prototype.c = function(final) {
    this.s.i = +(this.d = final || false);
    var bts = this.s.b;
    var dt = inflt(this.p, this.s, this.o);
    this.ondata(slc(dt, bts, this.s.b), this.d);
    this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
    this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
  };
  Inflate2.prototype.push = function(chunk, final) {
    this.e(chunk), this.c(final);
  };
  return Inflate2;
})();
var fltn = function(d, p, t, o) {
  for (var k in d) {
    var val = d[k], n = p + k, op = o;
    if (Array.isArray(val))
      op = mrg(o, val[1]), val = val[0];
    if (ArrayBuffer.isView(val))
      t[n] = [val, op];
    else {
      t[n += "/"] = [new u8(0), op];
      fltn(val, n, t, o);
    }
  }
};
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
function strToU8(str2, latin1) {
  if (latin1) {
    var ar_1 = new u8(str2.length);
    for (var i = 0; i < str2.length; ++i)
      ar_1[i] = str2.charCodeAt(i);
    return ar_1;
  }
  if (te)
    return te.encode(str2);
  var l = str2.length;
  var ar = new u8(str2.length + (str2.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i << 1));
      n.set(ar);
      ar = n;
    }
    var c = str2.charCodeAt(i);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str2.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
function zipSync(data, opts) {
  if (!opts)
    opts = {};
  var r = {};
  var files = [];
  fltn(data, "", r, opts);
  var o = 0;
  var tot = 0;
  for (var fn in r) {
    var _a3 = r[fn], file = _a3[0], p = _a3[1];
    var compression = p.level == 0 ? 0 : 8;
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    if (s > 65535)
      err(11);
    var d = compression ? deflateSync(file, p) : file, l = d.length;
    var c = crc();
    c.p(file);
    files.push(mrg(p, {
      size: file.length,
      crc: c.d(),
      c: d,
      f,
      m,
      u: s != fn.length || m && com.length != ms,
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  var out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (var i = 0; i < files.length; ++i) {
    var f = files[i];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    var badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}

// src/readers/limits.ts
var MiB = 1024 * 1024;
var SOURCE_MAX_BYTES = 500 * MiB;
var SOURCE_MAX_FILES = 5e3;
var FILE_MAX_BYTES = 10 * MiB;
var SKILL_MAX_BYTES = 10 * MiB;
var SKILL_MAX_FILES = 200;
var ZIP_UPLOAD_MAX_BYTES = 50 * MiB;
var ZIP_MAX_RATIO = 200;
var ZIP_RATIO_FLOOR_BYTES = 1 * MiB;
var DIR_MAX_VISITED = 1e5;
var DIR_MAX_DEPTH = 32;
var DEFAULT_READER_LIMITS = Object.freeze({
  maxBytes: SOURCE_MAX_BYTES,
  maxFiles: SOURCE_MAX_FILES,
  maxFileBytes: FILE_MAX_BYTES,
  maxSkillBytes: SKILL_MAX_BYTES,
  maxSkillFiles: SKILL_MAX_FILES,
  maxRatio: ZIP_MAX_RATIO,
  ratioFloorBytes: ZIP_RATIO_FLOOR_BYTES,
  maxVisited: DIR_MAX_VISITED,
  maxDepth: DIR_MAX_DEPTH
});
function resolveLimits(overrides) {
  const out = { ...DEFAULT_READER_LIMITS };
  if (!overrides) return out;
  for (const key of Object.keys(out)) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = Math.min(value, DEFAULT_READER_LIMITS[key]);
    }
  }
  return out;
}

// src/readers/zip.ts
var SIG_LOCAL = 67324752;
var SIG_CENTRAL = 33639248;
var SIG_EOCD = 101010256;
var SIG_ZIP64_LOCATOR = 117853008;
var EOCD_MIN = 22;
var CENTRAL_MIN = 46;
var LOCAL_MIN = 30;
var MAX_COMMENT = 65535;
var FLAG_ENCRYPTED = 1;
var FLAG_UTF8 = 2048;
var METHOD_STORED = 0;
var METHOD_DEFLATED = 8;
var HOST_UNIX = 3;
var HOST_DARWIN = 19;
var S_IFMT = 61440;
var S_IFREG = 32768;
var S_IFDIR = 16384;
var S_IFLNK = 40960;
var DOS_DIRECTORY = 16;
var INFLATE_SLICE = 64 * 1024;
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
var Crc32 = class {
  c = 4294967295;
  update(bytes) {
    let c = this.c;
    for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 255] ?? 0) ^ c >>> 8;
    this.c = c;
  }
  digest() {
    return (this.c ^ 4294967295) >>> 0;
  }
};
function crc32(bytes) {
  const crc2 = new Crc32();
  crc2.update(bytes);
  return crc2.digest();
}
var CP850_HIGH = (
  // french-ok: the code page's own accented letters, byte for byte
  "\xC7\xFC\xE9\xE2\xE4\xE0\xE5\xE7\xEA\xEB\xE8\xEF\xEE\xEC\xC4\xC5\xC9\xE6\xC6\xF4\xF6\xF2\xFB\xF9\xFF\xD6\xDC\xF8\xA3\xD8\xD7\u0192\xE1\xED\xF3\xFA\xF1\xD1\xAA\xBA\xBF\xAE\xAC\xBD\xBC\xA1\xAB\xBB\u2591\u2592\u2593\u2502\u2524\xC1\xC2\xC0\xA9\u2563\u2551\u2557\u255D\xA2\xA5\u2510\u2514\u2534\u252C\u251C\u2500\u253C\xE3\xC3\u255A\u2554\u2569\u2566\u2560\u2550\u256C\xA4\xF0\xD0\xCA\xCB\xC8\u0131\xCD\xCE\xCF\u2518\u250C\u2588\u2584\xA6\xCC\u2580\xD3\xDF\xD4\xD2\xF5\xD5\xB5\xFE\xDE\xDA\xDB\xD9\xFD\xDD\xAF\xB4\xAD\xB1\u2017\xBE\xB6\xA7\xF7\xB8\xB0\xA8\xB7\xB9\xB3\xB2\u25A0\xA0"
);
var CP850 = Array.from(CP850_HIGH);
function decodeCp850(bytes) {
  let out = "";
  for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP850[b - 128] ?? "\uFFFD";
  return out;
}
var strictUtf8 = new TextDecoder("utf-8", { fatal: true });
function tryUtf8(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}
function decodeName(raw, flags, unicodePath) {
  if (flags & FLAG_UTF8) {
    const name2 = tryUtf8(raw);
    if (name2 === null) throw new ReaderError("corrupt", "archive entry name is flagged UTF-8 but is not");
    return { name: name2, guessed: false };
  }
  const fromField = unicodePath ? tryUtf8(unicodePath) : null;
  if (fromField !== null) return { name: fromField, guessed: false };
  const asUtf8 = tryUtf8(raw);
  if (asUtf8 !== null) return { name: asUtf8, guessed: false };
  return { name: decodeCp850(raw), guessed: true };
}
async function readAt(handle, offset, length) {
  const out = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(out, done, length - done, offset + done);
    if (bytesRead === 0) throw new ReaderError("corrupt", "archive is truncated");
    done += bytesRead;
  }
  return out;
}
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function findEocd(tail) {
  const dv = view(tail);
  for (let at = tail.length - EOCD_MIN; at >= 0; at--) {
    if (dv.getUint32(at, true) !== SIG_EOCD) continue;
    if (at + EOCD_MIN + dv.getUint16(at + 20, true) === tail.length) return at;
  }
  return -1;
}
function extraFields(extra) {
  const dv = view(extra);
  const out = { zip64: null, unicodePath: null };
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = dv.getUint16(at, true);
    const len = dv.getUint16(at + 2, true);
    const body = extra.subarray(at + 4, at + 4 + len);
    if (body.length !== len) throw new ReaderError("corrupt", "archive entry has a truncated extra field");
    if (id === 1) out.zip64 = body;
    if (id === 28789) out.unicodePath = body;
    at += 4 + len;
  }
  return out;
}
function unicodePathFor(field, rawName) {
  if (!field || field.length < 5 || field[0] !== 1) return null;
  return view(field).getUint32(1, true) === crc32(rawName) ? field.subarray(5) : null;
}
async function readCentralDirectory(handle, fileSize, limits) {
  if (fileSize < EOCD_MIN) throw new ReaderError("corrupt", "not a zip archive");
  const tailLength = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(handle, tailStart, tailLength);
  const eocdAt = findEocd(tail);
  if (eocdAt === -1) throw new ReaderError("corrupt", "not a zip archive (no central directory)");
  const eocd = view(tail.subarray(eocdAt));
  const disk = eocd.getUint16(4, true);
  const cdDisk = eocd.getUint16(6, true);
  const onDisk = eocd.getUint16(8, true);
  const count = eocd.getUint16(10, true);
  const cdSize = eocd.getUint32(12, true);
  const cdStart = eocd.getUint32(16, true);
  const hasZip64Locator = eocdAt >= 20 && view(tail).getUint32(eocdAt - 20, true) === SIG_ZIP64_LOCATOR;
  if (hasZip64Locator && (count === 65535 || cdSize === 4294967295 || cdStart === 4294967295)) {
    throw new ReaderError("unsupported", "ZIP64 archives are not supported");
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) {
    throw new ReaderError("unsupported", "multi-part zip archives are not supported");
  }
  if (count > limits.maxFiles) {
    throw new ReaderError("too-many-files", `the archive holds more than ${limits.maxFiles} entries`);
  }
  const eocdOffset = tailStart + eocdAt;
  if (cdStart + cdSize > eocdOffset) throw new ReaderError("corrupt", "archive central directory is out of bounds");
  const cd = await readAt(handle, cdStart, cdSize);
  const dv = view(cd);
  const entries = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_MIN > cd.length || dv.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ReaderError("corrupt", "archive central directory is malformed");
    }
    const host = dv.getUint8(at + 5);
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc2 = dv.getUint32(at + 16, true);
    let compressedSize = dv.getUint32(at + 20, true);
    let size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const externalAttr = dv.getUint32(at + 38, true);
    let localOffset = dv.getUint32(at + 42, true);
    const end = at + CENTRAL_MIN + nameLength + extraLength + commentLength;
    if (end > cd.length) throw new ReaderError("corrupt", "archive central directory is malformed");
    const rawName = cd.slice(at + CENTRAL_MIN, at + CENTRAL_MIN + nameLength);
    const extra = extraFields(cd.subarray(at + CENTRAL_MIN + nameLength, at + CENTRAL_MIN + nameLength + extraLength));
    if (size === 4294967295 || compressedSize === 4294967295 || localOffset === 4294967295) {
      const z = extra.zip64 ? view(extra.zip64) : null;
      let zi = 0;
      const next = () => {
        if (!z || zi + 8 > z.byteLength) throw new ReaderError("corrupt", "archive entry has a malformed ZIP64 field");
        const value = z.getBigUint64(zi, true);
        zi += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReaderError("too-large", "archive entry is too large");
        return Number(value);
      };
      if (size === 4294967295) size = next();
      if (compressedSize === 4294967295) compressedSize = next();
      if (localOffset === 4294967295) localOffset = next();
    }
    entries.push({
      rawName,
      flags,
      method,
      crc: crc2,
      compressedSize,
      size,
      localOffset,
      externalAttr,
      host,
      unicodePath: extra.unicodePath
    });
    at = end;
  }
  return { entries, cdStart };
}
function inflateEntry(compressed, entry, path) {
  const out = new Uint8Array(entry.size);
  if (entry.method === METHOD_STORED) {
    if (entry.compressedSize !== entry.size) throw new ReaderError("corrupt", `${path}: stored entry with two different sizes`);
    out.set(compressed);
  } else {
    let produced = 0;
    let finished = false;
    const inflater = new Inflate((chunk, final) => {
      if (produced + chunk.length > entry.size) {
        throw new ReaderError("bomb", `${path} expands beyond the size it declares`);
      }
      out.set(chunk, produced);
      produced += chunk.length;
      if (final) finished = true;
    });
    try {
      for (let at = 0; at < compressed.length; at += INFLATE_SLICE) {
        const end = Math.min(at + INFLATE_SLICE, compressed.length);
        inflater.push(compressed.subarray(at, end), end === compressed.length);
      }
      if (compressed.length === 0) inflater.push(new Uint8Array(0), true);
    } catch (err2) {
      if (err2 instanceof ReaderError) throw err2;
      throw new ReaderError("corrupt", `${path} could not be decompressed`);
    }
    if (!finished || produced !== entry.size) throw new ReaderError("corrupt", `${path} is shorter than it declares`);
  }
  if (crc32(out) !== entry.crc) throw new ReaderError("corrupt", `${path} fails its checksum`);
  return out;
}
function fileType(host, externalAttr, name2) {
  if (name2.endsWith("/") || name2.endsWith("\\")) return "dir";
  if (host === HOST_UNIX || host === HOST_DARWIN) {
    const mode = externalAttr >>> 16 & S_IFMT;
    if (mode === S_IFLNK) return "link";
    if (mode === S_IFDIR) return "dir";
    if (mode !== 0 && mode !== S_IFREG) return "special";
  }
  if (externalAttr & DOS_DIRECTORY) return "dir";
  return "file";
}
async function readZipFile(file, wants, options = {}) {
  const limits = resolveLimits(options.limits);
  const globs = compileWants(wants);
  const maxArchiveBytes = Math.min(options.maxArchiveBytes ?? ZIP_UPLOAD_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES);
  const handle = await open(file, "r");
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ReaderError("corrupt", "the archive is not a file");
    if (st.size > maxArchiveBytes) throw new ReaderError("too-large", `the archive is larger than ${maxArchiveBytes} bytes`);
    const { entries, cdStart } = await readCentralDirectory(handle, st.size, limits);
    let declared = 0;
    for (const e of entries) {
      declared += e.size;
      if (declared > limits.maxBytes) {
        throw new ReaderError("too-large", `the archive expands beyond ${limits.maxBytes} bytes`);
      }
      if (e.size > limits.ratioFloorBytes && e.size / Math.max(e.compressedSize, 1) > limits.maxRatio) {
        throw new ReaderError("bomb", "the archive holds an entry with an implausible expansion ratio");
      }
    }
    const skipped = [];
    const notices = [];
    const reportedPrefixes = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const e of entries) {
      const { name: name2, guessed } = decodeName(e.rawName, e.flags, unicodePathFor(e.unicodePath, e.rawName));
      const segments = archiveEntrySegments(name2);
      const type = fileType(e.host, e.externalAttr, name2);
      if (segments.length === 0) {
        if (type === "dir") continue;
        throw new ReaderError("unsafe-path", "archive entry without a name");
      }
      const path = segments.join("/");
      if (type === "dir") continue;
      if (seen.has(path)) throw new ReaderError("corrupt", `archive holds ${JSON.stringify(path)} twice`);
      seen.add(path);
      const denied = deniedPrefix(segments);
      if (denied !== null) {
        if (!reportedPrefixes.has(denied)) {
          reportedPrefixes.add(denied);
          skipped.push({ path: denied, reason: "blocked" });
        }
        continue;
      }
      if (!globs.some((g) => globMatches(g, segments))) continue;
      if (type === "link" || type === "special") {
        skipped.push({ path, reason: type });
        continue;
      }
      if (isNestedArchive(segments[segments.length - 1] ?? "")) {
        skipped.push({ path, reason: "nested-archive" });
        continue;
      }
      if (segments.some(isUnportableSegment)) {
        skipped.push({ path, reason: "unportable-name" });
        continue;
      }
      if (guessed) notices.push({ path, code: "name-not-utf8" });
      candidates.push({
        path,
        size: e.size,
        ref: {
          rawName: e.rawName,
          flags: e.flags,
          method: e.method,
          crc: e.crc,
          compressedSize: e.compressedSize,
          size: e.size,
          localOffset: e.localOffset,
          path
        }
      });
    }
    const plan = planSelection(candidates, limits);
    for (const c of plan.keep) {
      if (c.ref.flags & FLAG_ENCRYPTED) throw new ReaderError("unsupported", `${c.path} is encrypted`);
      if (c.ref.method !== METHOD_STORED && c.ref.method !== METHOD_DEFLATED) {
        throw new ReaderError("unsupported", `${c.path} uses an unsupported compression method`);
      }
    }
    const spans = [];
    for (const c of plan.keep) {
      const header = await readAt(handle, c.ref.localOffset, LOCAL_MIN);
      const hv = view(header);
      if (hv.getUint32(0, true) !== SIG_LOCAL) throw new ReaderError("corrupt", `${c.path}: local header not found`);
      const nameLength = hv.getUint16(26, true);
      const extraLength = hv.getUint16(28, true);
      const localName = await readAt(handle, c.ref.localOffset + LOCAL_MIN, nameLength);
      if (localName.length !== c.ref.rawName.length || localName.some((b, i) => b !== c.ref.rawName[i])) {
        throw new ReaderError("corrupt", `${c.path}: local and central names differ`);
      }
      const start = c.ref.localOffset + LOCAL_MIN + nameLength + extraLength;
      const end = start + c.ref.compressedSize;
      if (end > cdStart) throw new ReaderError("corrupt", `${c.path}: data runs into the central directory`);
      spans.push({ start: c.ref.localOffset, end, ref: c.ref });
    }
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (prev && cur && cur.start < prev.end) throw new ReaderError("corrupt", "archive entries overlap");
    }
    const files = /* @__PURE__ */ new Map();
    let totalBytes = 0;
    for (const span of spans) {
      const compressed = await readAt(handle, span.end - span.ref.compressedSize, span.ref.compressedSize);
      files.set(span.ref.path, inflateEntry(compressed, span.ref, span.ref.path));
      totalBytes += span.ref.size;
    }
    skipped.push(...plan.skipped);
    skipped.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files, skipped, notices, totalBytes };
  } finally {
    await handle.close();
  }
}

// src/sources/adapter.ts
function decodeText(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return normalizeNewlines(text.charCodeAt(0) === 65279 ? text.slice(1) : text);
}
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}
function slugKey(raw, max2 = 64) {
  return raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, max2).replace(/-+$/, "");
}
function uniqueKey(base, taken, max2 = 64) {
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const tail = `-${n}`;
    key = base.slice(0, max2 - tail.length).replace(/-+$/, "") + tail;
  }
  taken.add(key);
  return key;
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${B64[n >> 18 & 63]}${B64[n >> 12 & 63]}==`;
  } else if (rest === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += `${B64[n >> 18 & 63]}${B64[n >> 12 & 63]}${B64[n >> 6 & 63]}=`;
  }
  return out;
}
function sniffPicture(bytes) {
  const at = (i) => bytes[i] ?? -1;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => at(i) === b)) return "image/png";
  if (at(0) === 255 && at(1) === 216 && at(2) === 255) return "image/jpeg";
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
function listNames(names, max2 = 10) {
  return names.slice(0, max2).join(", ") + (names.length > max2 ? ", \u2026" : "");
}

// src/sources/openbot.ts
var OPENBOT_SOURCE_ID = "openbot";
var OPENBOT_MANIFEST_FILE = "openbot-import.json";
var OPENBOT_FORMAT = "openbot-agent-import";
var OPENBOT_VERSION = 1;
var FALLBACK_APP = "import";
var MAX = {
  agents: 100,
  displayName: 100,
  title: 120,
  soul: 2e5,
  memories: 256,
  memoryText: 4e3,
  skills: 200,
  skillContent: 1048576,
  companionFiles: 200,
  routines: 64,
  routineName: 80,
  instruction: 1e5,
  timezone: 64,
  groups: 100,
  groupName: 160,
  members: 100,
  sourceApp: 64,
  /** What `ctx.agents.setAvatar` takes once decoded. */
  avatarBytes: 2 * 1024 * 1024
};
var CODE_FILE = /\.(py|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|rb|pl|php|ps1|psm1|bat|cmd|exe|dll|so|dylib|bin|jar|wasm)$/i;
var CODE_DIR = /^(scripts|bin)$/i;
var HHMM2 = /^([01]\d|2[0-3]):[0-5]\d$/;
var isObject2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isInt = (value, min, max2) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max2;
var clip = (text, max2) => text.length > max2 ? text.slice(0, max2) : text;
function refuse(where, what) {
  throw new ManifestError(`Not a valid agent export: ${where}: ${what}.`);
}
function agentPath(value, key, where) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") refuse(where, "not a path");
  const path = value.normalize("NFC").replace(/\/+$/, "");
  if (!path.startsWith(`agents/${key.normalize("NFC")}/`) || !isSafeRelativePath(path)) refuse(where, "path outside its agent folder");
  return path;
}
var ok = (value, warnings = []) => ({ ok: true, value, warnings });
var no = (reason) => ({ ok: false, reason });
var list = (values) => [...new Set(values)].sort((a, b) => a - b).join(",");
function advancedCron(schedule) {
  const months = schedule.months;
  if (!Array.isArray(months) || months.length === 0 || !months.every((m) => isInt(m, 1, 12))) return no("its months are not valid");
  const monthField = new Set(months).size === 12 ? "*" : list(months);
  const days = schedule.days;
  if (!isObject2(days)) return no("its days are not valid");
  let dom = "*";
  let dow = "*";
  if (days.kind === "days-of-week") {
    if (!Array.isArray(days.days) || days.days.length === 0 || !days.days.every((d) => isInt(d, 0, 6))) return no("its days are not valid");
    dow = new Set(days.days).size === 7 ? "*" : list(days.days);
  } else if (days.kind === "days-of-month") {
    if (!Array.isArray(days.days) || days.days.length === 0 || !days.days.every((d) => isInt(d, 1, 31))) return no("its days are not valid");
    dom = list(days.days);
  } else if (days.kind !== "every-day") {
    return no("its days are not valid");
  }
  const time3 = schedule.time;
  if (!isObject2(time3)) return no("its time is not valid");
  let minuteHour;
  if (time3.kind === "at-time") {
    if (typeof time3.time !== "string" || !HHMM2.test(time3.time)) return no("its time is not valid");
    const [h = "0", m = "0"] = time3.time.split(":");
    minuteHour = `${Number(m)} ${Number(h)}`;
  } else if (time3.kind === "every") {
    if (!isInt(time3.amount, 1, 1e5) || time3.unit !== "minutes" && time3.unit !== "hours") return no("its rate is not valid");
    const minutes = time3.unit === "hours" ? time3.amount * 60 : time3.amount;
    if (minutes < 60 && 60 % minutes === 0) minuteHour = minutes === 1 ? "* *" : `*/${minutes} *`;
    else if (minutes % 60 === 0 && minutes <= 1440 && 1440 % minutes === 0) {
      const hours = minutes / 60;
      minuteHour = hours === 24 ? "0 0" : hours === 1 ? "0 *" : `0 */${hours}`;
    } else return no(`every ${minutes} minutes divides neither an hour nor a day evenly, which a cron cannot express`);
  } else {
    return no("its time is not valid");
  }
  return ok({ kind: "cron", expression: `${minuteHour} ${dom} ${monthField} ${dow}` });
}
function decodeSchedule(schedule) {
  if (!isObject2(schedule) || typeof schedule.kind !== "string") return no("it has no schedule");
  const time3 = typeof schedule.time === "string" && HHMM2.test(schedule.time) ? schedule.time : null;
  switch (schedule.kind) {
    case "hourly":
      return isInt(schedule.minute, 0, 59) ? ok({ kind: "hourly", minute: schedule.minute }) : no("its minute is not valid");
    case "daily":
      return time3 ? ok({ kind: "daily", time: time3 }) : no("its time is not valid");
    case "weekdays":
      return time3 ? ok({ kind: "weekdays", time: time3 }) : no("its time is not valid");
    case "weekly":
      if (!isInt(schedule.weekday, 0, 6)) return no("its weekday is not valid");
      return time3 ? ok({ kind: "weekly", days: [schedule.weekday], time: time3 }) : no("its time is not valid");
    case "monthly":
      if (!isInt(schedule.day, 1, 31)) return no("its day of the month is not valid");
      return time3 ? ok({ kind: "monthly", day: schedule.day, time: time3 }) : no("its time is not valid");
    case "interval": {
      if (!isInt(schedule.amount, 1, 1e5)) return no("its interval is not valid");
      const factor = schedule.unit === "minutes" ? 1 : schedule.unit === "hours" ? 60 : schedule.unit === "days" ? 1440 : 0;
      if (factor === 0) return no("its interval unit is not valid");
      const minutes = schedule.amount * factor;
      if (minutes > 527040) return no("it runs less than once a year");
      const warnings = schedule.anchorAt !== void 0 ? ["it now runs on the clock, not counted from its original start"] : [];
      return ok({ kind: "interval", minutes }, warnings);
    }
    case "custom":
      if (typeof schedule.expression !== "string" || !schedule.expression.trim()) return no("its cron expression is empty");
      return ok({ kind: "cron", expression: clip(schedule.expression.trim(), 200) });
    case "advanced":
      return advancedCron(schedule);
    case "once":
      return no("it runs only once, which Timon does not import");
    default:
      return no("its schedule kind is unknown");
  }
}
function decodeRoutines(raw, owner, warnings) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${owner}: the routines are not a list, none is imported.`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    const label = isObject2(item) && typeof item.name === "string" && item.name.trim() ? `"${clip(item.name.trim(), MAX.routineName)}"` : `#${index + 1}`;
    if (!isObject2(item) || typeof item.name !== "string" || !item.name.trim()) {
      warnings.push(`${owner}: routine ${label} has no name, not imported.`);
      return;
    }
    const instruction = typeof item.instruction === "string" ? normalizeNewlines(item.instruction).trim() : "";
    if (!instruction) {
      warnings.push(`${owner}: routine ${label} has no instruction, not imported.`);
      return;
    }
    if (instruction.length > MAX.instruction) {
      warnings.push(`${owner}: routine ${label} has an instruction longer than ${MAX.instruction} characters, not imported.`);
      return;
    }
    const schedule = decodeSchedule(item.schedule);
    if (!schedule.ok) {
      warnings.push(`${owner}: routine ${label} is not imported: ${schedule.reason}.`);
      return;
    }
    for (const note of schedule.warnings) warnings.push(`${owner}: routine ${label}: ${note}.`);
    let timezone = null;
    if (typeof item.timezone === "string" && item.timezone.trim()) {
      if (item.timezone.trim().length <= MAX.timezone) timezone = item.timezone.trim();
      else warnings.push(`${owner}: routine ${label}: its time zone is not valid, the daemon's is used.`);
    }
    if (out.length >= MAX.routines) {
      warnings.push(`${owner}: routine ${label} is over the limit of ${MAX.routines} routines, not imported.`);
      return;
    }
    out.push({
      name: clip(item.name.trim(), MAX.routineName),
      instruction,
      schedule: schedule.value,
      timezone,
      enabledInSource: item.active !== false
    });
  });
  return out;
}
function decodeMemories(raw, owner, warnings) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${owner}: the memories are not a list, none is imported.`);
    return [];
  }
  const out = [];
  let tooLong = 0;
  let notText = 0;
  for (const item of raw) {
    if (typeof item !== "string") {
      notText += 1;
      continue;
    }
    const text = normalizeNewlines(item).trim();
    if (!text) continue;
    if (text.length > MAX.memoryText) {
      tooLong += 1;
      continue;
    }
    out.push(text);
  }
  if (notText > 0) warnings.push(`${owner}: ${notText} memories are not text, not imported.`);
  if (tooLong > 0) warnings.push(`${owner}: ${tooLong} memories longer than ${MAX.memoryText} characters are not imported.`);
  if (out.length > MAX.memories) {
    warnings.push(`${owner}: ${out.length - MAX.memories} memories over the limit of ${MAX.memories} are not imported.`);
    return out.slice(0, MAX.memories);
  }
  return out;
}
function skillIdOf(folder) {
  return folder.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100).replace(/[-.]+$/, "");
}
function decodeSkill(tree, path, owner, warnings) {
  const folder = path.split("/").pop() ?? "";
  const id = skillIdOf(folder);
  if (!SKILL_ID_RE.test(id)) {
    warnings.push(`${owner}: skill "${clip(folder, 100)}" has no usable name, not imported.`);
    return null;
  }
  const prefix = `${path}/`;
  const inside = [...tree.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  const main = inside.find((p) => p.toLowerCase() === "skill.md");
  if (main === void 0) {
    warnings.push(`${owner}: skill ${id} has no readable SKILL.md, not imported.`);
    return null;
  }
  const content = decodeText(tree.files.get(prefix + main));
  if (content === null || !content.trim()) {
    warnings.push(`${owner}: skill ${id}: its SKILL.md is not UTF-8 text, not imported.`);
    return null;
  }
  if (content.length > MAX.skillContent) {
    warnings.push(`${owner}: skill ${id}: its SKILL.md is too large, not imported.`);
    return null;
  }
  const companions = inside.filter((p) => p !== main);
  const leftOut = tree.skipped.some((s) => s.path === path || s.path.startsWith(prefix));
  const hasCode = companions.some((p) => CODE_FILE.test(p) || p.split("/").slice(0, -1).some((d) => CODE_DIR.test(d)));
  const companionFiles = companions.filter(isSafeRelativePath).slice(0, MAX.companionFiles);
  if (leftOut && companionFiles.length === 0 && !hasCode) {
    warnings.push(`${owner}: skill ${id} comes with files that cannot be read, not imported.`);
    return null;
  }
  const skill = { id, content };
  if (companionFiles.length > 0) skill.companionFiles = companionFiles;
  if (hasCode) skill.hasCode = true;
  return skill;
}
function decodeAvatar(tree, path, owner, warnings) {
  const bytes = tree.files.get(path);
  if (!bytes) {
    warnings.push(`${owner}: the picture is missing from the archive or too large, not imported.`);
    return null;
  }
  const mime = sniffPicture(bytes);
  if (!mime) {
    warnings.push(`${owner}: the picture is not a PNG, JPEG or WebP image, not imported.`);
    return null;
  }
  if (bytes.length > MAX.avatarBytes) {
    warnings.push(`${owner}: the picture is larger than 2 MiB, not imported.`);
    return null;
  }
  return { mime, dataBase64: toBase64(bytes) };
}
function readJson(tree) {
  const bytes = tree.files.get(OPENBOT_MANIFEST_FILE);
  if (!bytes) throw new ManifestError(`The archive holds no ${OPENBOT_MANIFEST_FILE} at its root, or it is too large.`);
  const text = decodeText(bytes);
  if (text === null) throw new ManifestError(`${OPENBOT_MANIFEST_FILE} is not UTF-8 text.`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManifestError(`${OPENBOT_MANIFEST_FILE} is not valid JSON.`);
  }
  if (!isObject2(value)) refuse("manifest", "not an object");
  if (value.format !== OPENBOT_FORMAT) refuse("format", `expected "${OPENBOT_FORMAT}"`);
  if (value.version !== OPENBOT_VERSION) {
    const which = isInt(value.version, 0, 1e6) ? `version ${value.version}` : "this version";
    throw new ManifestError(`${OPENBOT_MANIFEST_FILE}: ${which} is not supported, Timon reads version ${OPENBOT_VERSION}. Export again with an up-to-date skill, or update Timon.`);
  }
  return value;
}
function sourceOf(raw) {
  const source = isObject2(raw) ? raw : {};
  const app = typeof source.app === "string" ? slugKey(source.app, MAX.sourceApp) : "";
  let exportedAt = null;
  if (typeof source.exportedAt === "string" && source.exportedAt.length <= 64) {
    const at = new Date(source.exportedAt);
    if (!Number.isNaN(at.getTime())) exportedAt = at.toISOString();
  }
  return { app: app && app !== "unknown" ? app : FALLBACK_APP, exportedAt };
}
function openbotToManifest(tree) {
  const root = readJson(tree);
  const warnings = [];
  if (!Array.isArray(root.agents) || root.agents.length === 0) refuse("agents", "expected a non-empty list");
  let rawAgents = root.agents;
  if (rawAgents.length > MAX.agents) {
    warnings.push(`${rawAgents.length - MAX.agents} agents over the limit of ${MAX.agents} per import are left out.`);
    rawAgents = rawAgents.slice(0, MAX.agents);
  }
  const keys = /* @__PURE__ */ new Map();
  const takenKeys = /* @__PURE__ */ new Set();
  const agents = [];
  rawAgents.forEach((item, index) => {
    const where = `agents[${index}]`;
    if (!isObject2(item)) refuse(where, "not an object");
    if (typeof item.key !== "string" || !item.key.trim() || item.key.length > 200) refuse(`${where}.key`, "missing or invalid");
    const sourceKey = item.key;
    if (keys.has(sourceKey)) refuse(`${where}.key`, "two agents share this key");
    if (typeof item.name !== "string" || !item.name.trim()) refuse(`${where}.name`, "missing");
    if (typeof item.description !== "string") refuse(`${where}.description`, "missing");
    const name2 = item.name.trim();
    const owner = `Agent "${clip(name2, MAX.displayName)}"`;
    const key = uniqueKey(slugKey(sourceKey) || "agent", takenKeys);
    keys.set(sourceKey, key);
    const avatarPath = agentPath(item.avatar, sourceKey, `${where}.avatar`);
    const filesPath = agentPath(item.files, sourceKey, `${where}.files`);
    if (item.skills !== void 0 && item.skills !== null && !Array.isArray(item.skills)) refuse(`${where}.skills`, "expected a list");
    const skillPaths = (item.skills ?? []).map((p, i) => agentPath(p, sourceKey, `${where}.skills[${i}]`));
    if (name2.length > MAX.displayName) warnings.push(`${owner}: the name is shortened to ${MAX.displayName} characters.`);
    const description = normalizeNewlines(item.description).trim();
    if (description.length > MAX.soul) refuse(`${where}.description`, `longer than ${MAX.soul} characters`);
    const title = typeof item.title === "string" ? normalizeNewlines(item.title).trim() : "";
    const skills = [];
    for (const path of skillPaths) {
      if (path === null) continue;
      const skill = decodeSkill(tree, path, owner, warnings);
      if (!skill) continue;
      if (skills.length >= MAX.skills) {
        warnings.push(`${owner}: skill ${skill.id} is over the limit of ${MAX.skills} skills, not imported.`);
        continue;
      }
      skills.push(skill);
    }
    if (filesPath !== null) warnings.push(`${owner}: the working files (${filesPath}) are not imported.`);
    const agent = {
      key,
      displayName: clip(name2, MAX.displayName),
      soul: description || null,
      sourceRef: `${OPENBOT_SOURCE_ID}:${sourceKey}`
    };
    if (title) agent.title = clip(title, MAX.title);
    const memories = decodeMemories(item.memories, owner, warnings);
    if (memories.length > 0) agent.memories = memories.map((text) => ({ text, kind: "decision" }));
    if (skills.length > 0) agent.skills = skills;
    const routines = decodeRoutines(item.routines, owner, warnings);
    if (routines.length > 0) agent.routines = routines;
    const avatar = avatarPath === null ? null : decodeAvatar(tree, avatarPath, owner, warnings);
    if (avatar) agent.avatar = avatar;
    agents.push(agent);
  });
  const groups = decodeChannels(root.channels, keys, agents, warnings);
  const manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: sourceOf(root.source),
    agents
  };
  if (groups.length > 0) manifest.groups = groups;
  return { manifest, warnings };
}
function decodeChannels(raw, keys, agents, warnings) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) refuse("channels", "expected a list");
  const nameOf = new Map(agents.map((a) => [a.key, a.displayName]));
  const seen = /* @__PURE__ */ new Set();
  const takenKeys = /* @__PURE__ */ new Set();
  const groups = [];
  raw.forEach((item, index) => {
    const where = `channels[${index}]`;
    if (!isObject2(item)) refuse(where, "not an object");
    if (typeof item.key !== "string" || !item.key.trim() || item.key.length > 200) refuse(`${where}.key`, "missing or invalid");
    if (seen.has(item.key)) refuse(`${where}.key`, "two groups share this key");
    seen.add(item.key);
    if (typeof item.name !== "string" || !item.name.trim()) refuse(`${where}.name`, "missing");
    if (!Array.isArray(item.members)) refuse(`${where}.members`, "expected a list");
    const name2 = clip(item.name.trim(), MAX.groupName);
    const owner = `Group "${name2}"`;
    const members2 = [];
    let unknown = 0;
    for (const member of new Set(item.members)) {
      const key = typeof member === "string" ? keys.get(member) : void 0;
      if (key === void 0) {
        unknown += 1;
        continue;
      }
      if (members2.length < MAX.members) members2.push(key);
    }
    if (unknown > 0) warnings.push(`${owner}: ${unknown} members are not agents of this export, left out.`);
    if (members2.length === 0) {
      warnings.push(`${owner} has no member in this export: no team is made.`);
      return;
    }
    if (groups.length >= MAX.groups) {
      warnings.push(`${owner} is over the limit of ${MAX.groups} groups: no team is made.`);
      return;
    }
    if (typeof item.lead === "string" && item.lead) {
      const lead = keys.get(item.lead);
      if (lead !== void 0 && members2.includes(lead)) {
        warnings.push(`${owner}: ${nameOf.get(lead) ?? lead} led it at the source; a Timon team has no lead.`);
      }
    }
    const instructions = typeof item.instructions === "string" ? item.instructions.trim() : "";
    if (instructions) warnings.push(`${owner}: its instructions are not carried over, a Timon team holds none.`);
    const routines = Array.isArray(item.routines) ? item.routines.map((r, i) => isObject2(r) && typeof r.name === "string" && r.name.trim() ? r.name.trim() : `#${i + 1}`) : [];
    if (routines.length > 0) warnings.push(`${owner}: its routines are not imported (${listNames(routines.map((r) => clip(r, MAX.routineName)))}).`);
    const memories = Array.isArray(item.memories) ? item.memories.filter((m) => typeof m === "string" && m.trim()).length : 0;
    if (memories > 0) warnings.push(`${owner}: its ${memories} memories are not imported.`);
    groups.push({ key: uniqueKey(slugKey(item.key) || "group", takenKeys), name: name2, members: members2 });
  });
  return groups;
}
var OPENBOT_WANTS = [
  OPENBOT_MANIFEST_FILE,
  "agents/*/skills/**",
  ...["png", "jpg", "jpeg", "webp", "PNG", "JPG", "JPEG", "WEBP"].map((ext) => `agents/*/*.${ext}`)
];
var openbotSource = {
  id: OPENBOT_SOURCE_ID,
  // Prefixes the adapter's errors, which the user reads.
  label: "Agent export (Grok Bot, Hermes)",
  accepts: ["zip"],
  detect: [OPENBOT_MANIFEST_FILE],
  wants: OPENBOT_WANTS,
  toManifest: openbotToManifest
};

// src/sources/index.ts
var BUILTIN_SOURCES = [openbotSource];
var WARNINGS_MAX = 200;
var WARNING_CHARS = 500;
var SKIP_WORDS = {
  "blocked": "secrets, keys or tool folders, never read",
  "nested-archive": "archives inside the archive, never opened",
  "link": "links, never followed",
  "special": "special files",
  "unportable-name": "names a Windows disk cannot hold",
  "too-large": "files too large to be read",
  "skill-too-large": "skills too large to be read",
  "case-collision": "names that differ only by case"
};
function skippedWarnings(skipped) {
  const byReason = /* @__PURE__ */ new Map();
  for (const entry of skipped) byReason.set(entry.reason, [...byReason.get(entry.reason) ?? [], entry.path]);
  return [...byReason].map(([reason, paths]) => `Left out of the archive, ${SKIP_WORDS[reason] ?? reason}: ${listNames(paths)}.`);
}
function capWarnings(warnings) {
  const clipped = warnings.map((w) => w.length > WARNING_CHARS ? `${w.slice(0, WARNING_CHARS - 1)}\u2026` : w);
  if (clipped.length <= WARNINGS_MAX) return clipped;
  return [...clipped.slice(0, WARNINGS_MAX - 1), `${clipped.length - WARNINGS_MAX + 1} more warnings are not shown.`];
}
function manifestFromSource(adapter, tree) {
  const { manifest, warnings } = adapter.toManifest(tree);
  try {
    return parseManifest({ ...manifest, warnings: capWarnings([...warnings, ...skippedWarnings(tree.skipped)]) });
  } catch (err2) {
    if (err2 instanceof ManifestError) throw new ManifestError(`${adapter.label}: ${err2.message}`);
    throw err2;
  }
}

// src/engine.ts
var MANIFEST_MAX_BYTES = 10 * 1024 * 1024;
async function readZip(path, wants) {
  try {
    return await readZipFile(path, wants);
  } catch (err2) {
    if (err2 instanceof ReaderError) throw new ManifestError(`The archive cannot be read: ${err2.message}.`);
    throw err2;
  }
}
async function readManifestFromZip(path, sources = BUILTIN_SOURCES) {
  const zipSources = sources.filter((s) => s.accepts.includes("zip"));
  const detect = [MANIFEST_FILE, ...zipSources.flatMap((s) => s.detect)];
  const found = await readZip(path, detect);
  const bytes = found.files.get(MANIFEST_FILE);
  if (bytes) {
    if (bytes.length > MANIFEST_MAX_BYTES) throw new ManifestError(`${MANIFEST_FILE} is too large to be read.`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ManifestError(`${MANIFEST_FILE} is not UTF-8 text.`);
    }
    return parseManifestText(text);
  }
  if (found.skipped.some((s) => s.path === MANIFEST_FILE)) throw new ManifestError(`${MANIFEST_FILE} is too large to be read.`);
  const present2 = [...found.files.keys()].map((p) => p.split("/"));
  const source = zipSources.find((s) => s.detect.some((glob) => {
    const compiled = compileGlob(glob);
    return present2.some((segments) => globMatches(compiled, segments));
  }));
  if (!source) {
    throw new ManifestError(`The archive holds no ${MANIFEST_FILE} at its root, nor an agent export Timon recognises.`);
  }
  return manifestFromSource(source, await readZip(path, source.wants));
}
async function projectsOf(ctx) {
  try {
    const projects = await ctx.projects.list();
    return projects.map((p) => ({ slug: p.slug, name: p.name })).sort((a, b) => (a.name ?? a.slug).localeCompare(b.name ?? b.slug) || a.slug.localeCompare(b.slug));
  } catch (err2) {
    ctx.log.warn("projects could not be listed for the preview:", err2 instanceof Error ? err2.message : "unknown error");
    return [];
  }
}
function createEngine(ctx) {
  const records = createRecords(ctx.storage.kv);
  trackAgents(ctx, records);
  const engineCtx = ctx;
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => void 0);
    return run;
  };
  return {
    preview: (manifest, options) => serial(async () => {
      const { preview } = await planImport(engineCtx, records, manifest, options);
      return { ...preview, projects: await projectsOf(ctx) };
    }),
    apply: (manifest, options) => serial(async () => applyPlan(engineCtx, records, await planImport(engineCtx, records, manifest, options)))
  };
}

// src/hermes/detect.ts
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { posix, win32 } from "node:path";
var HERMES_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var HERMES_DEFAULT_PROFILE = "default";
var HERMES_MAX_PROFILES = 100;
var IDENTITY_MARKERS = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
var DELETED_DIR = ".deleted";
function currentPlatform() {
  return { platform: process.platform, env: process.env, home: homedir2() };
}
function hermesRootCandidate(host = currentPlatform()) {
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA?.trim();
    if (local && win32.isAbsolute(local)) return { root: win32.join(local, "hermes"), label: "%LOCALAPPDATA%\\hermes" };
    if (!host.home || !win32.isAbsolute(host.home)) return null;
    return { root: win32.join(host.home, "AppData", "Local", "hermes"), label: "%USERPROFILE%\\AppData\\Local\\hermes" };
  }
  if (!host.home || !posix.isAbsolute(host.home)) return null;
  return { root: posix.join(host.home, ".hermes"), label: "~/.hermes" };
}
async function isRealDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function hasIdentity(dir, join7) {
  for (const marker of IDENTITY_MARKERS) {
    if (await exists(join7(dir, marker))) return true;
  }
  return false;
}
async function detectHermes(host = currentPlatform()) {
  const candidate = hermesRootCandidate(host);
  if (!candidate) return null;
  const join7 = host.platform === "win32" ? win32.join : posix.join;
  try {
    if (!(await stat(candidate.root)).isDirectory()) return null;
  } catch {
    return null;
  }
  const profiles = [];
  if (await hasIdentity(candidate.root, join7)) profiles.push({ name: HERMES_DEFAULT_PROFILE, root: candidate.root });
  const profilesDir = join7(candidate.root, "profiles");
  if (await isRealDirectory(profilesDir)) {
    let names = [];
    try {
      names = (await readdir(profilesDir)).sort();
    } catch {
      names = [];
    }
    for (const name2 of names) {
      if (profiles.length >= HERMES_MAX_PROFILES) break;
      if (!HERMES_PROFILE_RE.test(name2) || name2 === HERMES_DEFAULT_PROFILE) continue;
      const root = join7(profilesDir, name2);
      if (!await isRealDirectory(root)) continue;
      if (await exists(join7(profilesDir, DELETED_DIR, name2))) continue;
      if (!await hasIdentity(root, join7)) continue;
      profiles.push({ name: name2, root });
    }
  }
  if (profiles.length === 0) return null;
  return { root: candidate.root, label: candidate.label, profiles };
}

// src/hermes/source.ts
import { lstat as lstat4 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/readers/dir.ts
import { constants } from "node:fs";
import { lstat as lstat2, open as open2, readdir as readdir2, stat as stat2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
async function readExactly(ref, size, path) {
  let handle;
  try {
    handle = await open2(ref.abs, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    throw new ReaderError("changed", `${path} could not be reopened (it changed while the source was read)`);
  }
  try {
    const st = await handle.stat();
    const sameFile = st.isFile() && st.size === size && st.nlink <= 1 && (ref.ino === 0 || st.ino === ref.ino && st.dev === ref.dev);
    if (!sameFile) throw new ReaderError("changed", `${path} changed while the source was read`);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) throw new ReaderError("changed", `${path} shrank while the source was read`);
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
async function readDirSource(root, wants, options = {}) {
  const limits = resolveLimits(options.limits);
  const globs = compileWants(wants);
  let rootStat;
  try {
    rootStat = await stat2(root);
  } catch {
    throw new ReaderError("not-a-directory", "the source folder does not exist");
  }
  if (!rootStat.isDirectory()) throw new ReaderError("not-a-directory", "the source is not a folder");
  const skipped = [];
  const candidates = [];
  let visited = 0;
  const stack = [{ raw: [], segments: [] }];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let names;
    try {
      names = await readdir2(join2(root, ...dir.raw));
    } catch {
      continue;
    }
    names.sort();
    for (const name2 of names) {
      if (++visited > limits.maxVisited) {
        throw new ReaderError("too-many-files", `the source folder holds more than ${limits.maxVisited} entries`);
      }
      const raw = [...dir.raw, name2];
      const segments = [...dir.segments, name2.normalize("NFC")];
      const path = segments.join("/");
      if (isDeniedSegment(name2)) {
        skipped.push({ path, reason: "blocked" });
        continue;
      }
      let st;
      try {
        st = await lstat2(join2(root, ...raw));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path, reason: "link" });
        continue;
      }
      if (st.isDirectory()) {
        if (!globs.some((g) => globMayMatchBelow(g, segments))) continue;
        if (segments.length >= limits.maxDepth) {
          throw new ReaderError("too-deep", `the source folder is nested deeper than ${limits.maxDepth} levels`);
        }
        stack.push({ raw, segments });
        continue;
      }
      if (!globs.some((g) => globMatches(g, segments))) continue;
      if (!st.isFile()) {
        skipped.push({ path, reason: "special" });
        continue;
      }
      if (st.nlink > 1) {
        skipped.push({ path, reason: "hard-link" });
        continue;
      }
      if (isNestedArchive(name2)) {
        skipped.push({ path, reason: "nested-archive" });
        continue;
      }
      if (segments.some(isUnportableSegment)) {
        skipped.push({ path, reason: "unportable-name" });
        continue;
      }
      candidates.push({ path, size: st.size, ref: { abs: join2(root, ...raw), dev: st.dev, ino: st.ino } });
    }
  }
  const plan = planSelection(candidates, limits);
  const files = /* @__PURE__ */ new Map();
  let totalBytes = 0;
  for (const c of plan.keep) {
    files.set(c.path, await readExactly(c.ref, c.size, c.path));
    totalBytes += c.size;
  }
  skipped.push(...plan.skipped);
  skipped.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, skipped, notices: [], totalBytes };
}

// src/hermes/env-names.ts
import { constants as constants2 } from "node:fs";
import { lstat as lstat3, open as open3 } from "node:fs/promises";
import { join as join3 } from "node:path";
var ENV_FILE_MAX_BYTES = 256 * 1024;
var ENV_NAMES_MAX = 64;
var ENV_NAME_MAX_LENGTH = 100;
var NO_FOLLOW2 = constants2.O_NOFOLLOW ?? 0;
var isNameStart = (b) => b >= 65 && b <= 90 || b >= 97 && b <= 122 || b === 95;
var isNamePart = (b) => isNameStart(b) || b >= 48 && b <= 57;
var isBlank = (b) => b === 32 || b === 9;
var EXPORT = [101, 120, 112, 111, 114, 116];
function parseEnvNames(bytes) {
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  let truncated = false;
  let i = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
  while (i < bytes.length) {
    let j = i;
    while (isBlank(bytes[j])) j++;
    if (EXPORT.every((b, k) => bytes[j + k] === b) && isBlank(bytes[j + EXPORT.length])) {
      j += EXPORT.length;
      while (isBlank(bytes[j])) j++;
    }
    const start = j;
    if (j < bytes.length && isNameStart(bytes[j])) {
      j++;
      while (j < bytes.length && isNamePart(bytes[j])) j++;
      const end = j;
      while (isBlank(bytes[j])) j++;
      if (bytes[j] === 61 && end - start <= ENV_NAME_MAX_LENGTH) {
        let name2 = "";
        for (let k = start; k < end; k++) name2 += String.fromCharCode(bytes[k]);
        if (!seen.has(name2)) {
          if (names.length < ENV_NAMES_MAX) {
            seen.add(name2);
            names.push(name2);
          } else {
            truncated = true;
          }
        }
      }
    }
    while (j < bytes.length && bytes[j] !== 10) j++;
    i = j + 1;
  }
  return { names, truncated };
}
async function readEnvNames(profileRoot) {
  const path = join3(profileRoot, ".env");
  let st;
  try {
    st = await lstat3(path);
  } catch {
    return { names: [], skipped: null, truncated: false };
  }
  if (st.isSymbolicLink()) return { names: [], skipped: "link", truncated: false };
  if (!st.isFile()) return { names: [], skipped: "special", truncated: false };
  if (st.nlink > 1) return { names: [], skipped: "hard-link", truncated: false };
  if (st.size > ENV_FILE_MAX_BYTES) return { names: [], skipped: "too-large", truncated: false };
  let handle;
  try {
    handle = await open3(path, constants2.O_RDONLY | NO_FOLLOW2);
  } catch {
    return { names: [], skipped: "unreadable", truncated: false };
  }
  const bytes = new Uint8Array(st.size);
  try {
    const now = await handle.stat();
    const same = now.isFile() && now.size === st.size && now.nlink <= 1 && (st.ino === 0 || now.ino === st.ino && now.dev === st.dev);
    if (!same) return { names: [], skipped: "unreadable", truncated: false };
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const parsed = parseEnvNames(bytes.subarray(0, offset));
    return { names: parsed.names, skipped: null, truncated: parsed.truncated };
  } catch {
    return { names: [], skipped: "unreadable", truncated: false };
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

// ../../orchestrator/node_modules/js-yaml/dist/js-yaml.mjs
var NOT_RESOLVED = /* @__PURE__ */ Symbol("NOT_RESOLVED");
function defineScalarTag(tagName, options) {
  return {
    tagName,
    nodeKind: "scalar",
    implicit: options.implicit ?? false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    implicitFirstChars: options.implicitFirstChars ?? null,
    resolve: options.resolve,
    identify: options.identify,
    represent: options.represent ?? ((data) => String(data)),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineSequenceTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "sequence",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addItem: options.addItem,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineMappingTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "mapping",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addPair: options.addPair,
    has: options.has,
    keys: options.keys,
    get: options.get,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
var strTag = defineScalarTag("tag:yaml.org,2002:str", {
  resolve: (source) => source,
  identify: (data) => typeof data === "string"
});
var NULL_VALUES$1 = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullCoreTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES$1.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object2) => object2 === null,
  represent: () => "null"
});
var nullJsonTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: ["n"],
  resolve: (source, isExplicit) => {
    if (source === "null" || isExplicit && source === "") return null;
    return NOT_RESOLVED;
  },
  identify: (object2) => object2 === null,
  represent: () => "null"
});
var NULL_VALUES = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullYaml11Tag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object2) => object2 === null,
  represent: () => "null"
});
var TRUE_VALUES$2 = [
  "true",
  "True",
  "TRUE"
];
var FALSE_VALUES$2 = [
  "false",
  "False",
  "FALSE"
];
var boolCoreTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "t",
    "T",
    "f",
    "F"
  ],
  resolve: (source) => {
    if (TRUE_VALUES$2.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$2.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object2) => Object.prototype.toString.call(object2) === "[object Boolean]",
  represent: (object2) => object2 ? "true" : "false"
});
var TRUE_VALUES$1 = ["true"];
var FALSE_VALUES$1 = ["false"];
var boolJsonTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: ["t", "f"],
  resolve: (source) => {
    if (TRUE_VALUES$1.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$1.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object2) => Object.prototype.toString.call(object2) === "[object Boolean]",
  represent: (object2) => object2 ? "true" : "false"
});
var TRUE_VALUES = [
  "true",
  "True",
  "TRUE",
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON"
];
var FALSE_VALUES = [
  "false",
  "False",
  "FALSE",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var boolYaml11Tag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "y",
    "Y",
    "n",
    "N",
    "t",
    "T",
    "f",
    "F",
    "o",
    "O"
  ],
  resolve: (source) => {
    if (TRUE_VALUES.indexOf(source) !== -1) return true;
    if (FALSE_VALUES.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object2) => Object.prototype.toString.call(object2) === "[object Boolean]",
  represent: (object2) => object2 ? "true" : "false"
});
var YAML_INTEGER_IMPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
var YAML_INTEGER_EXPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$2(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$2(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$2(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intCoreTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger$2,
  identify: (object2) => Number.isInteger(object2) && !Object.is(object2, -0) && object2.toString(10).indexOf("e") < 0,
  represent: (object2) => object2.toString(10)
});
var YAML_INTEGER_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)$");
var YAML_INTEGER_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$1(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$1(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intJsonTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlInteger$1,
  identify: (object2) => Number.isInteger(object2) && !Object.is(object2, -0) && object2.toString(10).indexOf("e") < 0,
  represent: (object2) => object2.toString(10)
});
var YAML_INTEGER_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:0|[1-9][0-9_]*))$");
function parseYamlInteger(source) {
  let value = source.replace(/_/g, "");
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  if (value.includes(":")) {
    let result = 0;
    for (const part of value.split(":")) result = result * 60 + Number(part);
    return sign * result;
  }
  if (value !== "0" && value[0] === "0") return sign * parseInt(value, 8);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger(source) {
  if (!YAML_INTEGER_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intYaml11Tag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger,
  identify: (object2) => Number.isInteger(object2) && !Object.is(object2, -0) && object2.toString(10).indexOf("e") < 0,
  represent: (object2) => object2.toString(10)
});
var YAML_FLOAT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$2(source) {
  if (!YAML_FLOAT_PATTERN$1.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase();
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  const result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN$1.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$2(object2) {
  if (isNaN(object2)) return ".nan";
  if (object2 === Number.POSITIVE_INFINITY) return ".inf";
  if (object2 === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object2, -0)) return "-0.0";
  const result = object2.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatCoreTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat$2,
  identify: (object2) => typeof object2 === "number" && (!Number.isInteger(object2) || Object.is(object2, -0) || object2.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$2
});
var YAML_FLOAT_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$");
var YAML_FLOAT_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_FLOAT_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
    let value = source.toLowerCase();
    const sign = value[0] === "-" ? -1 : 1;
    if ("+-".includes(value[0])) value = value.slice(1);
    if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (value === ".nan") return NaN;
    const result2 = sign * parseFloat(value);
    return Number.isFinite(result2) ? result2 : NOT_RESOLVED;
  }
  if (!YAML_FLOAT_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = Number(source);
  if (Number.isFinite(result)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$1(object2) {
  if (isNaN(object2)) return ".nan";
  if (object2 === Number.POSITIVE_INFINITY) return ".inf";
  if (object2 === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object2, -0)) return "-0.0";
  const result = object2.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatJsonTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlFloat$1,
  identify: (object2) => typeof object2 === "number" && (!Number.isInteger(object2) || Object.is(object2, -0) || object2.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$1
});
var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:(?:[0-9][0-9_]*)?\\.[0-9_]*)(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat(source) {
  if (!YAML_FLOAT_PATTERN.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase().replace(/_/g, "");
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  let result = 0;
  if (value.includes(":")) {
    for (const part of value.split(":")) result = result * 60 + Number(part);
    result *= sign;
  } else result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat(object2) {
  if (isNaN(object2)) return ".nan";
  if (object2 === Number.POSITIVE_INFINITY) return ".inf";
  if (object2 === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object2, -0)) return "-0.0";
  const result = object2.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatYaml11Tag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat,
  identify: (object2) => typeof object2 === "number" && (!Number.isInteger(object2) || Object.is(object2, -0) || object2.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat
});
var mergeTag = defineScalarTag("tag:yaml.org,2002:merge", {
  implicit: true,
  implicitFirstChars: ["<"],
  resolve: (source, isExplicit) => {
    if (source === "<<" || isExplicit && source === "") return "<<";
    return NOT_RESOLVED;
  },
  identify: () => false
});
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function resolveYamlBinary(source) {
  const input = source.replace(/\s/g, "");
  if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) return NOT_RESOLVED;
  const binary = atob(input);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}
function representYamlBinary(object2) {
  let binary = "";
  for (let index = 0; index < object2.length; index++) binary += String.fromCharCode(object2[index]);
  return btoa(binary);
}
var binaryTag = defineScalarTag("tag:yaml.org,2002:binary", {
  resolve: resolveYamlBinary,
  identify: (object2) => Object.prototype.toString.call(object2) === "[object Uint8Array]",
  represent: representYamlBinary
});
var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
function makeUtcDate(year, month, day, hour = 0, minute = 0, second = 0, fraction = 0) {
  const date3 = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  date3.setUTCFullYear(year, month, day);
  return date3;
}
function resolveYamlTimestamp(source) {
  let match = YAML_DATE_REGEXP.exec(source);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(source);
  if (match === null) return NOT_RESOLVED;
  const year = +match[1];
  const month = +match[2] - 1;
  const day = +match[3];
  if (!match[4]) {
    const date4 = makeUtcDate(year, month, day);
    if (date4.getUTCFullYear() !== year || date4.getUTCMonth() !== month || date4.getUTCDate() !== day) return NOT_RESOLVED;
    return date4;
  }
  const hour = +match[4];
  const minute = +match[5];
  const second = +match[6];
  let fraction = 0;
  if (hour > 23 || minute > 59 || second > 59) return NOT_RESOLVED;
  if (match[7]) {
    let value = match[7].slice(0, 3);
    while (value.length < 3) value += "0";
    fraction = +value;
  }
  const date3 = makeUtcDate(year, month, day, hour, minute, second, fraction);
  if (date3.getUTCFullYear() !== year || date3.getUTCMonth() !== month || date3.getUTCDate() !== day) return NOT_RESOLVED;
  if (match[9]) {
    const offsetHour = +match[10];
    const offsetMinute = +(match[11] || 0);
    if (offsetHour > 23 || offsetMinute > 59) return NOT_RESOLVED;
    const offset = (offsetHour * 60 + offsetMinute) * 6e4;
    date3.setTime(date3.getTime() - (match[9] === "-" ? -offset : offset));
  }
  return date3;
}
var timestampTag = defineScalarTag("tag:yaml.org,2002:timestamp", {
  implicit: true,
  implicitFirstChars: [..."0123456789"],
  resolve: resolveYamlTimestamp,
  identify: (object2) => object2 instanceof Date,
  represent: (object2) => object2.toISOString()
});
var seqTag = defineSequenceTag("tag:yaml.org,2002:seq", {
  create: () => [],
  addItem: (container, item) => {
    container.push(item);
  },
  identify: Array.isArray
});
function isPlainObject2(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === null || prototype === Object.prototype;
}
function pick2(object2, keys) {
  const result = {};
  for (const key of keys) if (object2[key] !== void 0) result[key] = object2[key];
  return result;
}
var omapTag = defineSequenceTag("tag:yaml.org,2002:omap", {
  create: () => ({
    list: [],
    seen: /* @__PURE__ */ new Set()
  }),
  addItem: (carrier, item) => {
    let key;
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve an ordered map item";
      key = item.keys().next().value;
    } else if (isPlainObject2(item)) {
      const itemKeys = Object.keys(item);
      if (itemKeys.length !== 1) return "cannot resolve an ordered map item";
      key = itemKeys[0];
    } else return "cannot resolve an ordered map item";
    if (carrier.seen.has(key)) return "duplicate key in ordered map";
    carrier.seen.add(key);
    carrier.list.push(item);
    return "";
  },
  finalize: (carrier) => carrier.list,
  identify: () => false
});
var pairsTag = defineSequenceTag("tag:yaml.org,2002:pairs", {
  create: () => [],
  addItem: (container, item) => {
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve a pairs item";
      container.push(item.entries().next().value);
      return "";
    }
    if (Object.prototype.toString.call(item) !== "[object Object]") return "cannot resolve a pairs item";
    const object2 = item;
    const keys = Object.keys(object2);
    if (keys.length !== 1) return "cannot resolve a pairs item";
    container.push([keys[0], object2[keys[0]]]);
    return "";
  },
  identify: () => false
});
var mapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject2,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    if (key !== null && typeof key === "object") return "object-based map does not support complex keys";
    const normalizedKey = String(key);
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    if (key !== null && typeof key === "object") return false;
    return Object.prototype.hasOwnProperty.call(container, String(key));
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var setTag = defineMappingTag("tag:yaml.org,2002:set", {
  create: () => /* @__PURE__ */ new Set(),
  identify: (data) => data instanceof Set,
  represent: (data) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of data) map.set(key, null);
    return map;
  },
  addPair: (container, key, value) => {
    if (value !== null) return "cannot resolve a set item";
    container.add(key);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: () => null
});
function createTagDefinitionMap() {
  return {
    scalar: /* @__PURE__ */ Object.create(null),
    sequence: /* @__PURE__ */ Object.create(null),
    mapping: /* @__PURE__ */ Object.create(null)
  };
}
function createTagDefinitionListMap() {
  return {
    scalar: [],
    sequence: [],
    mapping: []
  };
}
function compileTags(tags) {
  const result = [];
  for (const tag of tags) {
    let index = result.length;
    for (let previousIndex = 0; previousIndex < result.length; previousIndex++) {
      const previous = result[previousIndex];
      if (previous.nodeKind === tag.nodeKind && previous.tagName === tag.tagName && previous.matchByTagPrefix === tag.matchByTagPrefix) {
        index = previousIndex;
        break;
      }
    }
    result[index] = tag;
  }
  return result;
}
var Schema = class Schema2 {
  tags;
  /** @internal */
  implicitScalarTags;
  /**
  * Dispatch implicit scalar resolvers by `source.charAt(0)`. Each bucket holds
  * the resolvers that may match that key, in schema order; a key absent from
  * the map uses
  * {@link Schema.implicitScalarAnyFirstChar}
  * (resolvers that declared no first-char constraint, so they apply to any
  * first character).
  */
  implicitScalarByFirstChar;
  implicitScalarAnyFirstChar;
  /**
  * The default scalar tag (`!!str`), resolved once so the composer's fallback
  * for unresolved plain scalars avoids a keyed lookup per scalar.
  *
  * @internal
  */
  defaultScalarTag;
  /**
  * The default container tags (`!!seq` / `!!map`), used by the dumper: when a
  * value is identified by its default tag, the tag is implicit and not
  * printed. Undefined if the schema does not define them (then such values
  * can't be dumped).
  *
  * @internal
  */
  defaultSequenceTag;
  /** @internal */
  defaultMappingTag;
  exact;
  prefix;
  constructor(tags) {
    const compiledTags = compileTags(tags);
    const implicitScalarTags = [];
    const exact = createTagDefinitionMap();
    const prefix = createTagDefinitionListMap();
    for (const tag of compiledTags) {
      if (tag.nodeKind === "scalar" && tag.implicit) {
        if (tag.matchByTagPrefix) throw new Error("Implicit scalar tags cannot match by tag prefix");
        implicitScalarTags.push(tag);
      }
      switch (tag.nodeKind) {
        case "scalar":
          if (tag.matchByTagPrefix) prefix.scalar.push(tag);
          else exact.scalar[tag.tagName] = tag;
          break;
        case "sequence":
          if (tag.matchByTagPrefix) prefix.sequence.push(tag);
          else exact.sequence[tag.tagName] = tag;
          break;
        case "mapping":
          if (tag.matchByTagPrefix) prefix.mapping.push(tag);
          else exact.mapping[tag.tagName] = tag;
          break;
      }
    }
    const implicitScalarAnyFirstChar = implicitScalarTags.filter((tag) => tag.implicitFirstChars === null);
    const keys = /* @__PURE__ */ new Set();
    for (const tag of implicitScalarTags) if (tag.implicitFirstChars !== null) for (const key of tag.implicitFirstChars) keys.add(key);
    const implicitScalarByFirstChar = /* @__PURE__ */ new Map();
    for (const key of keys) implicitScalarByFirstChar.set(key, implicitScalarTags.filter((tag) => tag.implicitFirstChars === null || tag.implicitFirstChars.indexOf(key) !== -1));
    const defaultScalarTag = exact.scalar["tag:yaml.org,2002:str"];
    if (!defaultScalarTag) throw new Error("schema does not define the default scalar tag (tag:yaml.org,2002:str)");
    this.tags = compiledTags;
    this.implicitScalarTags = implicitScalarTags;
    this.implicitScalarByFirstChar = implicitScalarByFirstChar;
    this.implicitScalarAnyFirstChar = implicitScalarAnyFirstChar;
    this.defaultScalarTag = defaultScalarTag;
    this.defaultSequenceTag = exact.sequence["tag:yaml.org,2002:seq"];
    this.defaultMappingTag = exact.mapping["tag:yaml.org,2002:map"];
    this.exact = exact;
    this.prefix = prefix;
  }
  /** @internal */
  lookupScalarTag(tagName) {
    const exactTag = this.exact.scalar[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.scalar) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupSequenceTag(tagName) {
    const exactTag = this.exact.sequence[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.sequence) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupMappingTag(tagName) {
    const exactTag = this.exact.mapping[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.mapping) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  resolveImplicitScalarTag(source) {
    const candidates = this.implicitScalarByFirstChar.get(source.charAt(0)) ?? this.implicitScalarAnyFirstChar;
    for (const tag2 of candidates) {
      const value = tag2.resolve(source, false, tag2.tagName);
      if (value !== NOT_RESOLVED) return {
        value,
        tag: tag2
      };
    }
    const tag = this.defaultScalarTag;
    return {
      value: tag.resolve(source, false, tag.tagName),
      tag
    };
  }
  /**
  * Creates a new schema with the specified tags added. If a tag already
  * exists, it is replaced by the specified tag.
  *
  * @example
  *
  * ```javascript
  * import { CORE_SCHEMA, mergeTag, realMapTag } from 'js-yaml'
  *
  * const schema = CORE_SCHEMA.withTags(mergeTag, realMapTag)
  * ```
  */
  withTags(...tags) {
    let flatTags = [];
    for (const tag of tags) flatTags = flatTags.concat(tag);
    return new Schema2([...this.tags, ...flatTags]);
  }
};
var FAILSAFE_SCHEMA = new Schema([
  strTag,
  seqTag,
  mapTag
]);
var JSON_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullJsonTag,
  boolJsonTag,
  intJsonTag,
  floatJsonTag
]);
var CORE_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullCoreTag,
  boolCoreTag,
  intCoreTag,
  floatCoreTag
]);
var YAML11_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullYaml11Tag,
  boolYaml11Tag,
  intYaml11Tag,
  floatYaml11Tag,
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag
]);
var DUMP_SCHEMA = YAML11_SCHEMA.withTags({
  ...intYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = intYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? intCoreTag.resolve(source, isExplicit, tagName) : result;
  }
}, {
  ...floatYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = floatYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? floatCoreTag.resolve(source, isExplicit, tagName) : result;
  }
});
var realMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => /* @__PURE__ */ new Map(),
  addPair: (container, key, value) => {
    container.set(key, value);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: (container, key) => container.get(key),
  identify: (data) => data instanceof Map || isPlainObject2(data),
  represent: (data) => {
    if (data instanceof Map) return data;
    const map = /* @__PURE__ */ new Map();
    const obj = data;
    for (const key of Object.keys(obj)) map.set(key, obj[key]);
    return map;
  }
});
function normalizeKey(key) {
  if (Array.isArray(key)) {
    const array2 = Array.prototype.slice.call(key);
    for (let index = 0; index < array2.length; index++) {
      if (Array.isArray(array2[index])) return null;
      if (typeof array2[index] === "object" && Object.prototype.toString.call(array2[index]) === "[object Object]") array2[index] = "[object Object]";
    }
    return String(array2);
  }
  if (typeof key === "object" && Object.prototype.toString.call(key) === "[object Object]") return "[object Object]";
  return String(key);
}
var legacyMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject2,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === null) return "nested arrays are not supported inside keys";
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    const normalizedKey = normalizeKey(key);
    return normalizedKey !== null && Object.prototype.hasOwnProperty.call(container, normalizedKey);
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var DEFAULT_SNIPPET_OPTIONS = {
  maxLength: 79,
  indent: 1,
  linesBefore: 3,
  linesAfter: 2
};
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  let head = "";
  let tail = "";
  const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
  };
}
function padStart(string3, max2) {
  return " ".repeat(Math.max(max2 - string3.length, 0)) + string3;
}
function makeSnippet(mark, options) {
  if (!mark.buffer) return null;
  const opts = {
    ...DEFAULT_SNIPPET_OPTIONS,
    ...options
  };
  const re = /\r?\n|\r|\0/g;
  const lineStarts = [0];
  const lineEnds = [];
  let match;
  let foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  let result = "";
  const lineNoLength = Math.min(mark.line + opts.linesAfter, lineEnds.length).toString().length;
  const maxLineLength = opts.maxLength - (opts.indent + lineNoLength + 3);
  for (let i = 1; i <= opts.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
    result = `${" ".repeat(opts.indent)}${padStart((mark.line - i + 1).toString(), lineNoLength)} | ${line2.str}
${result}`;
  }
  const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += `${" ".repeat(opts.indent)}${padStart((mark.line + 1).toString(), lineNoLength)} | ${line.str}
`;
  result += `${"-".repeat(opts.indent + lineNoLength + 3 + line.pos)}^
`;
  for (let i = 1; i <= opts.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
    result += `${" ".repeat(opts.indent)}${padStart((mark.line + i + 1).toString(), lineNoLength)} | ${line2.str}
`;
  }
  return result.replace(/\n$/, "");
}
function formatError(exception, compact) {
  let where = "";
  if (!exception.mark) return exception.reason;
  if (exception.mark.name) where += `in "${exception.mark.name}" `;
  where += `(${exception.mark.line + 1}:${exception.mark.column + 1})`;
  if (!compact && exception.mark.snippet) where += `

${exception.mark.snippet}`;
  return `${exception.reason} ${where}`;
}
var YAMLException = class YAMLException2 extends Error {
  reason;
  mark;
  /**
  * Optional `mark` contains source snippet data. Usually, use
  * {@link YAMLException.throwAt} instead of passing it directly.
  */
  constructor(reason, mark) {
    super();
    this.name = "YAMLException";
    this.reason = reason;
    this.mark = mark;
    this.message = formatError(this, false);
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
  /**
  * Returns the formatted error, omitting the source snippet in compact mode.
  */
  toString(compact) {
    return `${this.name}: ${formatError(this, compact)}`;
  }
  /**
  * Builds a YAMLException with a source snippet and throws it. `source` is
  * the raw input text; `position` is an offset into it.
  */
  static throwAt(source, position, message, filename = "") {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < position; index++) {
      const ch = source.charCodeAt(index);
      if (ch === 10) {
        line++;
        lineStart = index + 1;
      } else if (ch === 13) {
        line++;
        if (source.charCodeAt(index + 1) === 10) index++;
        lineStart = index + 1;
      }
    }
    const mark = {
      name: filename,
      buffer: source,
      position,
      line,
      column: position - lineStart
    };
    mark.snippet = makeSnippet(mark);
    throw new YAMLException2(message, mark);
  }
};
var EVENT_ID = {
  DOCUMENT: 1,
  SEQUENCE: 2,
  MAPPING: 3,
  SCALAR: 4,
  ALIAS: 5,
  POP: 6
};
var SCALAR_STYLE = {
  PLAIN: 1,
  SINGLE_QUOTED: 2,
  DOUBLE_QUOTED: 3,
  LITERAL_BLOCK: 4,
  FOLDED_BLOCK: 5
};
var COLLECTION_STYLE = {
  BLOCK: 1,
  FLOW: 2
};
var CHOMPING_MODE = {
  CLIP: 1,
  STRIP: 2,
  KEEP: 3
};
var NO_RANGE$3 = -1;
function simpleEscapeSequence(c) {
  switch (c) {
    case 48:
      return "\0";
    case 97:
      return "\x07";
    case 98:
      return "\b";
    case 116:
      return "	";
    case 9:
      return "	";
    case 110:
      return "\n";
    case 118:
      return "\v";
    case 102:
      return "\f";
    case 114:
      return "\r";
    case 101:
      return "\x1B";
    case 32:
      return " ";
    case 34:
      return '"';
    case 47:
      return "/";
    case 92:
      return "\\";
    case 78:
      return "\x85";
    case 95:
      return "\xA0";
    case 76:
      return "\u2028";
    case 80:
      return "\u2029";
    default:
      return "";
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (let i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function charFromCodepoint(c) {
  if (c <= 65535) return String.fromCharCode(c);
  return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
}
function fromHexCode$1(c) {
  if (c >= 48 && c <= 57) return c - 48;
  return (c | 32) - 97 + 10;
}
function escapedHexLen$1(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  return 8;
}
function skipFoldedBreaks(input, position, end) {
  let breaks = 0;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10) {
      breaks++;
      position++;
    } else if (ch === 13) {
      breaks++;
      position++;
      if (input.charCodeAt(position) === 10) position++;
    } else if (ch === 32 || ch === 9) position++;
    else break;
  }
  return {
    position,
    breaks
  };
}
function foldedBreaks(count) {
  if (count === 1) return " ";
  return "\n".repeat(count - 1);
}
function getPlainValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, captureEnd);
}
function getSingleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 39) {
      result += input.slice(captureStart, position) + "'";
      position += 2;
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getDoubleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 92) {
      result += input.slice(captureStart, position);
      position++;
      const escaped = input.charCodeAt(position);
      if (escaped === 10 || escaped === 13) position = skipFoldedBreaks(input, position, end).position;
      else if (escaped < 256 && simpleEscapeCheck[escaped]) {
        result += simpleEscapeMap[escaped];
        position++;
      } else {
        let hexLength = escapedHexLen$1(escaped);
        let hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          position++;
          const digit = fromHexCode$1(input.charCodeAt(position));
          hexResult = (hexResult << 4) + digit;
        }
        result += charFromCodepoint(hexResult);
        position++;
      }
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getBlockValue(input, start, end, indent, chomping, folded) {
  const textIndent = indent < 0 ? 0 : indent;
  const region = input.slice(start, end).replace(/\r\n?/g, "\n");
  const lines = region === "" ? [] : (region.endsWith("\n") ? region.slice(0, -1) : region).split("\n");
  let result = "";
  let didReadContent = false;
  let emptyLines = 0;
  let atMoreIndented = false;
  for (const line of lines) {
    let column = 0;
    while (column < textIndent && line.charCodeAt(column) === 32) column++;
    if (indent < 0 || column >= line.length) {
      emptyLines++;
      continue;
    }
    const content = line.slice(textIndent);
    const first = content.charCodeAt(0);
    if (folded) if (first === 32 || first === 9) {
      atMoreIndented = true;
      result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    } else if (atMoreIndented) {
      atMoreIndented = false;
      result += "\n".repeat(emptyLines + 1);
    } else if (emptyLines === 0) {
      if (didReadContent) result += " ";
    } else result += "\n".repeat(emptyLines);
    else result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    result += content;
    didReadContent = true;
    emptyLines = 0;
  }
  if (chomping === CHOMPING_MODE.KEEP) result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
  else if (chomping !== CHOMPING_MODE.STRIP) {
    if (didReadContent) result += "\n";
  }
  return result;
}
function getScalarValue(input, scalar) {
  if (scalar.valueStart === NO_RANGE$3) return "";
  const { valueStart, valueEnd } = scalar;
  if (scalar.fast) return input.slice(valueStart, valueEnd);
  switch (scalar.style) {
    case SCALAR_STYLE.SINGLE_QUOTED:
      return getSingleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.DOUBLE_QUOTED:
      return getDoubleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.LITERAL_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, false);
    case SCALAR_STYLE.FOLDED_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, true);
    default:
      return getPlainValue(input, valueStart, valueEnd);
  }
}
var DEFAULT_TAG_HANDLERS = Object.assign(/* @__PURE__ */ Object.create(null), {
  "!": "!",
  "!!": "tag:yaml.org,2002:"
});
function tagNameFull(rawTag, tagHandlers) {
  if (rawTag.startsWith("!<") && rawTag.endsWith(">")) return decodeURIComponent(rawTag.slice(2, -1));
  const handleEnd = rawTag.indexOf("!", 1);
  const handle = handleEnd === -1 ? "!" : rawTag.slice(0, handleEnd + 1);
  const prefix = tagHandlers?.[handle] ?? DEFAULT_TAG_HANDLERS[handle] ?? handle;
  return decodeURIComponent(prefix) + decodeURIComponent(rawTag.slice(handle.length));
}
var NO_RANGE$2 = -1;
var MERGE_TAG_NAME = "tag:yaml.org,2002:merge";
var DEFAULT_CONSTRUCTOR_OPTIONS = {
  filename: "",
  schema: CORE_SCHEMA,
  json: false,
  maxTotalMergeKeys: 1e4,
  maxAliases: -1
};
function eventPosition$1(event) {
  if ("tagStart" in event && event.tagStart !== NO_RANGE$2) return event.tagStart;
  if ("anchorStart" in event && event.anchorStart !== NO_RANGE$2) return event.anchorStart;
  if ("valueStart" in event && event.valueStart !== NO_RANGE$2) return event.valueStart;
  if ("start" in event) return event.start;
  return 0;
}
function throwError$1(state, message) {
  YAMLException.throwAt(state.source, state.position, message, state.filename);
}
function finalizeCollection(state, position, tag, carrier) {
  try {
    return tag.finalize(carrier);
  } catch (error) {
    if (error instanceof YAMLException) throw error;
    YAMLException.throwAt(state.source, position, error instanceof Error ? error.message : String(error), state.filename);
  }
}
function constructScalar(state, event) {
  const source = getScalarValue(state.source, event);
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  const strTag2 = state.schema.defaultScalarTag;
  if (rawTag !== "") {
    if (rawTag === "!") return {
      value: source,
      tag: strTag2
    };
    const tagName = tagNameFull(rawTag, state.tagHandlers);
    const scalarTag = state.schema.lookupScalarTag(tagName);
    if (scalarTag) {
      const result = scalarTag.resolve(source, true, tagName);
      if (result === NOT_RESOLVED) throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      return {
        value: result,
        tag: scalarTag
      };
    }
    const collectionTagDef = state.schema.lookupMappingTag(tagName) ?? state.schema.lookupSequenceTag(tagName);
    if (collectionTagDef) {
      if (source !== "") throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      const carrier = collectionTagDef.create(tagName);
      return {
        value: collectionTagDef.carrierIsResult ? carrier : finalizeCollection(state, state.position, collectionTagDef, carrier),
        tag: collectionTagDef
      };
    }
    throwError$1(state, `unknown scalar tag !<${tagName}>`);
  }
  if (event.style === SCALAR_STYLE.PLAIN) return state.schema.resolveImplicitScalarTag(source);
  return {
    value: strTag2.resolve(source, false, strTag2.tagName),
    tag: strTag2
  };
}
function collectionTagName(state, event, defaultTagName) {
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  return rawTag === "" || rawTag === "!" ? defaultTagName : tagNameFull(rawTag, state.tagHandlers);
}
function isMappingTag(tag) {
  return tag.nodeKind === "mapping";
}
function chargeMergeWork(state) {
  state.totalMergeKeys++;
  if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) throwError$1(state, `merge keys exceeded maxTotalMergeKeys (${state.maxTotalMergeKeys})`);
}
function mergeKeys(state, frame, source, sourceTag) {
  chargeMergeWork(state);
  for (const sourceKey of sourceTag.keys(source)) {
    chargeMergeWork(state);
    if (frame.tag.has(frame.value, sourceKey)) continue;
    const err2 = frame.tag.addPair(frame.value, sourceKey, sourceTag.get(source, sourceKey));
    if (err2) throwError$1(state, err2);
    frame.overridable ??= /* @__PURE__ */ new Set();
    frame.overridable.add(sourceKey);
  }
}
function mergeSource(state, frame, source, sourceTag) {
  state.position = frame.keyPosition;
  if (isMappingTag(sourceTag)) mergeKeys(state, frame, source, sourceTag);
  else if (sourceTag.nodeKind === "sequence" && Array.isArray(source)) {
    if (source.length > 100) throwError$1(state, "abnormal merge sequence size");
    for (const element of source) {
      const elementTag = state.nodeTags.get(element);
      if (!elementTag) throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
      mergeKeys(state, frame, element, elementTag);
    }
  } else throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
}
function addMappingValue(state, frame, key, value, tag) {
  state.position = frame.keyPosition;
  if (frame.keyIsMerge) {
    mergeSource(state, frame, value, tag);
    return;
  }
  if (!state.json && frame.tag.has(frame.value, key) && !frame.overridable?.has(key)) throwError$1(state, "duplicated mapping key");
  const err2 = frame.tag.addPair(frame.value, key, value);
  if (err2) throwError$1(state, err2);
  frame.overridable?.delete(key);
}
function addValue(state, value, tag) {
  const frame = state.frames[state.frames.length - 1];
  if (frame.kind === "document") {
    frame.value = value;
    frame.hasValue = true;
  } else if (frame.kind === "sequence") {
    if (isMappingTag(tag)) state.nodeTags.set(value, tag);
    const err2 = frame.tag.addItem(frame.value, value, frame.index++);
    if (err2) throwError$1(state, err2);
  } else if (frame.hasKey) {
    const key = frame.key;
    frame.key = void 0;
    frame.hasKey = false;
    addMappingValue(state, frame, key, value, tag);
  } else {
    frame.key = value;
    frame.keyPosition = state.position;
    frame.hasKey = true;
    frame.keyIsMerge = tag.tagName === MERGE_TAG_NAME;
  }
}
function storeAnchor(state, event, value, tag, isValueFinal) {
  if (event.anchorStart !== NO_RANGE$2) {
    const anchor2 = {
      value,
      tag,
      isValueFinal
    };
    state.anchors.set(state.source.slice(event.anchorStart, event.anchorEnd), anchor2);
    return anchor2;
  }
  return null;
}
function constructFromEvents(events, options) {
  const state = {
    ...DEFAULT_CONSTRUCTOR_OPTIONS,
    ...options,
    events,
    documents: [],
    eventIndex: 0,
    position: 0,
    frames: [],
    anchors: /* @__PURE__ */ new Map(),
    nodeTags: /* @__PURE__ */ new Map(),
    tagHandlers: /* @__PURE__ */ Object.create(null),
    totalMergeKeys: 0,
    aliasCount: 0
  };
  while (state.eventIndex < state.events.length) {
    const event = state.events[state.eventIndex++];
    state.position = eventPosition$1(event);
    switch (event.type) {
      case EVENT_ID.DOCUMENT:
        state.anchors = /* @__PURE__ */ new Map();
        state.nodeTags = /* @__PURE__ */ new Map();
        state.aliasCount = 0;
        state.tagHandlers = /* @__PURE__ */ Object.create(null);
        for (const directive of event.directives) if (directive.kind === "tag") state.tagHandlers[directive.handle] = directive.prefix;
        state.frames.push({
          kind: "document",
          position: state.position,
          value: void 0,
          hasValue: false
        });
        break;
      case EVENT_ID.SCALAR: {
        const { value, tag } = constructScalar(state, event);
        storeAnchor(state, event, value, tag, true);
        addValue(state, value, tag);
        break;
      }
      case EVENT_ID.SEQUENCE: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:seq");
        const tag = state.schema.lookupSequenceTag(tagName);
        if (!tag) throwError$1(state, `unknown sequence tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor2 = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "sequence",
          position: state.position,
          value,
          tag,
          anchor: anchor2,
          index: 0
        });
        break;
      }
      case EVENT_ID.MAPPING: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:map");
        const tag = state.schema.lookupMappingTag(tagName);
        if (!tag) throwError$1(state, `unknown mapping tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor2 = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "mapping",
          position: state.position,
          value,
          tag,
          anchor: anchor2,
          key: void 0,
          keyPosition: state.position,
          hasKey: false,
          keyIsMerge: false,
          overridable: null
        });
        break;
      }
      case EVENT_ID.ALIAS: {
        if (state.maxAliases !== -1 && ++state.aliasCount > state.maxAliases) throwError$1(state, `aliases exceeded maxAliases (${state.maxAliases})`);
        const name2 = state.source.slice(event.anchorStart, event.anchorEnd);
        const anchor2 = state.anchors.get(name2);
        if (!anchor2) throwError$1(state, `unidentified alias "${name2}"`);
        if (!anchor2.isValueFinal) throwError$1(state, `recursive alias "${name2}" is not supported for tag ${anchor2.tag.tagName} because it uses finalize()`);
        addValue(state, anchor2.value, anchor2.tag);
        break;
      }
      case EVENT_ID.POP: {
        const frame = state.frames.pop();
        if (frame.kind === "mapping" && frame.hasKey) {
          state.position = frame.keyPosition;
          throwError$1(state, "incomplete mapping pair in event stream");
        }
        if (frame.kind === "document") state.documents.push(frame.value);
        else {
          const value = frame.tag.carrierIsResult ? frame.value : finalizeCollection(state, frame.position, frame.tag, frame.value);
          if (frame.anchor) {
            frame.anchor.value = value;
            frame.anchor.isValueFinal = true;
          }
          addValue(state, value, frame.tag);
        }
        break;
      }
    }
  }
  return state.documents;
}
var NO_RANGE$1 = -1;
var HAS_OWN = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
var NS_URI_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$,_.!~*'()\[\]])`;
var NS_TAG_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$.~*'()_])`;
var PATTERN_TAG_URI = new RegExp(`^(?:${NS_URI_CHAR})*$`);
var PATTERN_TAG_SUFFIX = new RegExp(`^(?:${NS_TAG_CHAR})+$`);
var PATTERN_TAG_PREFIX = new RegExp(`^(?:!(?:${NS_URI_CHAR})*|${NS_TAG_CHAR}(?:${NS_URI_CHAR})*)$`);
var DEFAULT_PARSER_OPTIONS = {
  filename: "",
  maxDepth: 100
};
function addDocumentEvent(state, explicitStart, explicitEnd) {
  state.events.push({
    type: EVENT_ID.DOCUMENT,
    explicitStart,
    explicitEnd,
    directives: state.directives
  });
}
function addSequenceEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.SEQUENCE,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function addMappingEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.MAPPING,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function insertFlowPairMappingEvent(state, snapshot) {
  state.events.splice(snapshot.eventsLength, 0, {
    type: EVENT_ID.MAPPING,
    start: snapshot.position,
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1,
    style: COLLECTION_STYLE.FLOW
  });
}
function addScalarEvent(state, valueStart, valueEnd, anchorStart, anchorEnd, tagStart, tagEnd, style, chomping = CHOMPING_MODE.CLIP, indent = -1, fast = false) {
  state.events.push({
    type: EVENT_ID.SCALAR,
    valueStart,
    valueEnd,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style,
    chomping,
    indent,
    fast
  });
}
function addAliasEvent(state, anchorStart, anchorEnd) {
  state.events.push({
    type: EVENT_ID.ALIAS,
    anchorStart,
    anchorEnd
  });
}
function addPopEvent(state) {
  state.events.push({ type: EVENT_ID.POP });
}
function addEmptyScalarEvent(state) {
  addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, SCALAR_STYLE.PLAIN);
}
function emptyProperties() {
  return {
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1
  };
}
function snapshotState(state) {
  return {
    position: state.position,
    line: state.line,
    lineStart: state.lineStart,
    lineIndent: state.lineIndent,
    firstTabInLine: state.firstTabInLine,
    eventsLength: state.events.length
  };
}
function restoreState(state, snapshot) {
  state.position = snapshot.position;
  state.line = snapshot.line;
  state.lineStart = snapshot.lineStart;
  state.lineIndent = snapshot.lineIndent;
  state.firstTabInLine = snapshot.firstTabInLine;
  state.events.length = snapshot.eventsLength;
}
function throwError(state, message) {
  YAMLException.throwAt(state.input.slice(0, state.length), state.position, message, state.filename);
}
function isEol(c) {
  return c === 10 || c === 13;
}
function isWhiteSpace(c) {
  return c === 9 || c === 32;
}
function isWsOrEol(c) {
  return isWhiteSpace(c) || isEol(c);
}
function isWsOrEolOrEnd(c) {
  return c === 0 || isWsOrEol(c);
}
function isFlowIndicator(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromDecimalCode(c) {
  return c >= 48 && c <= 57 ? c - 48 : -1;
}
function fromHexCode(c) {
  if (c >= 48 && c <= 57) return c - 48;
  const lc2 = c | 32;
  if (lc2 >= 97 && lc2 <= 102) return lc2 - 97 + 10;
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  if (c === 85) return 8;
  return 0;
}
function isSimpleEscape(c) {
  return c === 48 || c === 97 || c === 98 || c === 116 || c === 9 || c === 110 || c === 118 || c === 102 || c === 114 || c === 101 || c === 32 || c === 34 || c === 47 || c === 92 || c === 78 || c === 95 || c === 76 || c === 80;
}
function consumeLineBreak(state) {
  if (state.input.charCodeAt(state.position) === 10) state.position++;
  else {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) state.position++;
  }
  state.line++;
  state.lineStart = state.position;
  state.lineIndent = 0;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments) {
  let lineBreaks = 0;
  let ch = state.input.charCodeAt(state.position);
  let hasSeparation = state.position === state.lineStart || isWsOrEol(state.input.charCodeAt(state.position - 1));
  while (ch !== 0) {
    while (isWhiteSpace(ch)) {
      hasSeparation = true;
      if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && hasSeparation && ch === 35) do
      ch = state.input.charCodeAt(++state.position);
    while (!isEol(ch) && ch !== 0);
    if (!isEol(ch)) break;
    consumeLineBreak(state);
    lineBreaks++;
    hasSeparation = true;
    ch = state.input.charCodeAt(state.position);
    while (ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
  }
  return lineBreaks;
}
function testDocumentSeparator(state, position = state.position) {
  const ch = state.input.charCodeAt(position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(position + 1) && ch === state.input.charCodeAt(position + 2)) {
    const following = state.input.charCodeAt(position + 3);
    return following === 0 || isWsOrEol(following);
  }
  return false;
}
function skipByteOrderMark(state) {
  if (state.position === state.lineStart && state.input.charCodeAt(state.position) === 65279) {
    state.position++;
    state.lineStart = state.position;
  }
}
function testDocumentBoundary(state) {
  if (state.position !== state.lineStart) return false;
  if (testDocumentSeparator(state)) return true;
  if (state.input.charCodeAt(state.position) !== 65279) return false;
  const snapshot = snapshotState(state);
  skipByteOrderMark(state);
  skipSeparationSpace(state, true);
  const ch = state.input.charCodeAt(state.position);
  const result = state.position === state.lineStart && (ch === 37 || ch === 45 && testDocumentSeparator(state));
  restoreState(state, snapshot);
  return result;
}
function skipUntilLineEnd(state) {
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0 && !isEol(ch)) ch = state.input.charCodeAt(++state.position);
}
function checkPrintable(state, start, end) {
  if (PATTERN_NON_PRINTABLE.test(state.input.slice(start, end))) throwError(state, "the stream contains non-printable characters");
}
function readTagProperty(state, props, inFlow) {
  if (state.input.charCodeAt(state.position) !== 33) return false;
  if (props.tagStart !== NO_RANGE$1) throwError(state, "duplication of a tag property");
  const start = state.position;
  let isVerbatim = false;
  let isNamed = false;
  let tagHandle = "!";
  let ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  }
  let suffixStart = state.position;
  let tagName;
  if (isVerbatim) {
    while (ch !== 0 && ch !== 62) ch = state.input.charCodeAt(++state.position);
    if (ch !== 62) throwError(state, "unexpected end of the stream within a verbatim tag");
    tagName = state.input.slice(suffixStart, state.position);
    state.position++;
  } else {
    while (ch !== 0 && !isWsOrEol(ch) && !(inFlow && isFlowIndicator(ch))) {
      if (ch === 33) if (!isNamed) {
        tagHandle = state.input.slice(suffixStart - 1, state.position + 1);
        if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
        isNamed = true;
        suffixStart = state.position + 1;
      } else throwError(state, "tag suffix cannot contain exclamation marks");
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(suffixStart, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
  }
  if (tagName && !(isVerbatim ? PATTERN_TAG_URI.test(tagName) : PATTERN_TAG_SUFFIX.test(tagName))) throwError(state, `tag name cannot contain such characters: ${tagName}`);
  if (!isVerbatim && tagHandle !== "!" && tagHandle !== "!!" && !HAS_OWN.call(state.tagHandlers, tagHandle)) throwError(state, `undeclared tag handle "${tagHandle}"`);
  props.tagStart = start;
  props.tagEnd = state.position;
  return true;
}
function readAnchorProperty(state, props) {
  if (state.input.charCodeAt(state.position) !== 38) return false;
  if (props.anchorStart !== NO_RANGE$1) throwError(state, "duplication of an anchor property");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an anchor node must contain at least one character");
  props.anchorStart = start;
  props.anchorEnd = state.position;
  return true;
}
function readAlias(state, props) {
  if (state.input.charCodeAt(state.position) !== 42) return false;
  if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) throwError(state, "alias node should not have any properties");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an alias node must contain at least one character");
  addAliasEvent(state, start, state.position);
  return true;
}
function readFlowScalarBreak(state, nodeIndent) {
  skipSeparationSpace(state, false);
  if (state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readSingleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 39) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 39) {
      if (state.input.charCodeAt(state.position + 1) === 39) {
        simple = false;
        state.position += 2;
        continue;
      }
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.SINGLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 34) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 34) {
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.DOUBLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (ch === 92) {
      simple = false;
      const escaped = state.input.charCodeAt(++state.position);
      if (isEol(escaped)) readFlowScalarBreak(state, nodeIndent);
      else if (isSimpleEscape(escaped)) state.position++;
      else {
        let hexLength = escapedHexLen(escaped);
        if (hexLength === 0) throwError(state, "unknown escape sequence");
        while (hexLength-- > 0) {
          state.position++;
          if (fromHexCode(state.input.charCodeAt(state.position)) < 0) throwError(state, "expected hexadecimal character");
        }
        state.position++;
      }
    } else if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readBlockScalar(state, parentIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  let chomping = CHOMPING_MODE.CLIP;
  let indent = -1;
  let detectedIndent = false;
  if (ch !== 124 && ch !== 62) return false;
  const style = ch === 124 ? SCALAR_STYLE.LITERAL_BLOCK : SCALAR_STYLE.FOLDED_BLOCK;
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    const current = state.input.charCodeAt(state.position);
    const digit = fromDecimalCode(current);
    if (current === 43 || current === 45) {
      if (chomping !== CHOMPING_MODE.CLIP) throwError(state, "repeat of a chomping mode identifier");
      chomping = current === 43 ? CHOMPING_MODE.KEEP : CHOMPING_MODE.STRIP;
      state.position++;
    } else if (digit >= 0) {
      if (digit === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      if (detectedIndent) throwError(state, "repeat of an indentation width identifier");
      indent = parentIndent + digit - 1;
      detectedIndent = true;
      state.position++;
    } else break;
  }
  let hadWhitespace = false;
  while (isWhiteSpace(state.input.charCodeAt(state.position))) {
    hadWhitespace = true;
    state.position++;
  }
  if (hadWhitespace && state.input.charCodeAt(state.position) === 35) skipUntilLineEnd(state);
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  else if (state.input.charCodeAt(state.position) !== 0) throwError(state, "a line break is expected");
  let contentIndent = detectedIndent ? indent : -1;
  let maxLeadingIndent = 0;
  const valueStart = state.position;
  let valueEnd = state.position;
  while (state.input.charCodeAt(state.position) !== 0) {
    const linePosition = state.position;
    let column = 0;
    while (state.input.charCodeAt(linePosition + column) === 32) column++;
    const first = state.input.charCodeAt(linePosition + column);
    if (first === 0) {
      if (contentIndent >= 0) {
        if (column > contentIndent) valueEnd = linePosition + column;
      } else if (column > 0) valueEnd = linePosition + column;
      break;
    }
    if (testDocumentBoundary(state)) break;
    if (!detectedIndent && contentIndent === -1 && isEol(first)) maxLeadingIndent = Math.max(maxLeadingIndent, column);
    if (!detectedIndent && contentIndent === -1 && !isEol(first)) {
      if (first === 9 && column < parentIndent) {
        state.position = linePosition + column;
        throwError(state, "tab characters must not be used in indentation");
      }
      if (column < maxLeadingIndent) {
        state.position = linePosition + column;
        throwError(state, "bad indentation of a mapping entry");
      }
    }
    if (contentIndent === -1 && first !== 0 && !isEol(first) && column < parentIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    if (!detectedIndent && first !== 0 && !isEol(first) && contentIndent === -1) contentIndent = column;
    const requiredIndent = contentIndent === -1 ? parentIndent + 1 : contentIndent;
    if (first !== 0 && !isEol(first) && column < requiredIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    skipUntilLineEnd(state);
    valueEnd = state.position;
    if (isEol(state.input.charCodeAt(state.position))) {
      consumeLineBreak(state);
      valueEnd = state.position;
    }
  }
  checkPrintable(state, valueStart, valueEnd);
  addScalarEvent(state, valueStart, valueEnd, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, style, chomping, contentIndent);
  return true;
}
function canStartPlainScalar(state, nodeContext) {
  const ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  if (ch === 0 || isWsOrEol(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96 || inFlow && isFlowIndicator(ch)) return false;
  if (ch === 63 || ch === 45) {
    const following = state.input.charCodeAt(state.position + 1);
    if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) return false;
  }
  return true;
}
function readPlainScalar(state, nodeIndent, nodeContext, props) {
  if (!canStartPlainScalar(state, nodeContext)) return false;
  const start = state.position;
  let end = state.position;
  let ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  let multiline = false;
  while (ch !== 0) {
    if (testDocumentBoundary(state)) break;
    if (ch === 58) {
      const following = state.input.charCodeAt(state.position + 1);
      if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) break;
    } else if (ch === 35) {
      if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
    } else if (inFlow && isFlowIndicator(ch)) break;
    else if (isEol(ch)) {
      const savedPosition = state.position;
      const savedLine = state.line;
      const savedLineStart = state.lineStart;
      const savedLineIndent = state.lineIndent;
      skipSeparationSpace(state, false);
      if (state.lineIndent >= nodeIndent) {
        multiline = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      }
      state.position = savedPosition;
      state.line = savedLine;
      state.lineStart = savedLineStart;
      state.lineIndent = savedLineIndent;
      break;
    }
    if (!isWhiteSpace(ch)) end = state.position + 1;
    ch = state.input.charCodeAt(++state.position);
  }
  if (end === start) return false;
  checkPrintable(state, start, end);
  addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN, CHOMPING_MODE.CLIP, -1, !multiline);
  return true;
}
function skipFlowSeparationSpace(state, nodeIndent) {
  const startLine = state.line;
  skipSeparationSpace(state, true);
  if (state.line > startLine && state.lineIndent < nodeIndent || state.firstTabInLine !== -1 && state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readFlowCollection(state, nodeIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  const isMapping = ch === 123;
  const start = state.position;
  let readNext = true;
  if (ch !== 91 && ch !== 123) return false;
  const terminator = isMapping ? 125 : 93;
  if (isMapping) addMappingEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  else addSequenceEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    skipFlowSeparationSpace(state, nodeIndent);
    let ch2 = state.input.charCodeAt(state.position);
    if (ch2 === terminator) {
      state.position++;
      addPopEvent(state);
      return true;
    } else if (!readNext) throwError(state, "missed comma between flow collection entries");
    else if (ch2 === 44) throwError(state, "expected the node content, but found ','");
    let isPair = false;
    let isExplicitPair = false;
    if (ch2 === 63 && isWsOrEol(state.input.charCodeAt(state.position + 1))) {
      isPair = isExplicitPair = true;
      state.position += 1;
      skipFlowSeparationSpace(state, nodeIndent);
    }
    const entryLine = state.line;
    const entryStart = snapshotState(state);
    const keyWasRead = parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    skipFlowSeparationSpace(state, nodeIndent);
    ch2 = state.input.charCodeAt(state.position);
    if ((isMapping || isExplicitPair || state.line === entryLine) && ch2 === 58) {
      isPair = true;
      state.position++;
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) {
        insertFlowPairMappingEvent(state, entryStart);
        if (!keyWasRead) addEmptyScalarEvent(state);
      } else if (!keyWasRead) addEmptyScalarEvent(state);
      if (!parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true)) addEmptyScalarEvent(state);
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) addPopEvent(state);
    } else if (isMapping && isPair) {
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
    } else if (isMapping) addEmptyScalarEvent(state);
    else if (isPair) {
      insertFlowPairMappingEvent(state, entryStart);
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
      addPopEvent(state);
    }
    ch2 = state.input.charCodeAt(state.position);
    if (ch2 === 44) {
      readNext = true;
      state.position++;
    } else readNext = false;
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockSequence(state, nodeIndent, props) {
  if (state.firstTabInLine !== -1 || state.input.charCodeAt(state.position) !== 45 || !isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) return false;
  addSequenceEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
  while (state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const entryLine = state.line;
    state.position++;
    const hadBreak = skipSeparationSpace(state, true) > 0;
    if (state.firstTabInLine !== -1 && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
    if (hadBreak && state.lineIndent <= nodeIndent) addEmptyScalarEvent(state);
    else parseNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    skipSeparationSpace(state, true);
    if (state.lineIndent < nodeIndent || state.position >= state.length) break;
    if (state.lineIndent > nodeIndent) throwError(state, "bad indentation of a sequence entry");
    if (state.line === entryLine && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
  }
  addPopEvent(state);
  return true;
}
function readBlockMapping(state, nodeIndent, flowIndent, props) {
  let atExplicitKey = false;
  let detected = false;
  let mappingOpened = false;
  let pendingExplicitKey = false;
  if (state.firstTabInLine !== -1) return false;
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const following = state.input.charCodeAt(state.position + 1);
    const entryLine = state.line;
    if ((ch === 63 || ch === 58) && isWsOrEolOrEnd(following)) {
      if (!mappingOpened) {
        addMappingEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
        mappingOpened = true;
      }
      if (ch === 63) {
        if (atExplicitKey) addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = true;
      } else if (atExplicitKey) atExplicitKey = false;
      else {
        addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = false;
      }
      state.position += 1;
      pendingExplicitKey = true;
    } else {
      if (atExplicitKey) {
        addEmptyScalarEvent(state);
        atExplicitKey = false;
      }
      const beforeKey = snapshotState(state);
      if (!parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
      if (state.line === entryLine) {
        ch = state.input.charCodeAt(state.position);
        while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!isWsOrEolOrEnd(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          if (!mappingOpened) {
            restoreState(state, beforeKey);
            addMappingEvent(state, beforeKey.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
            mappingOpened = true;
            parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true);
            ch = state.input.charCodeAt(state.position);
            while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
            state.position++;
          }
          detected = true;
          atExplicitKey = false;
          pendingExplicitKey = false;
        } else if (detected) throwError(state, "expected ':' after a mapping key");
        else {
          if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
            restoreState(state, beforeKey);
            return false;
          }
          return true;
        }
      } else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      else {
        if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
          restoreState(state, beforeKey);
          return false;
        }
        return true;
      }
    }
    if (parseNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, pendingExplicitKey)) pendingExplicitKey = false;
    if (!atExplicitKey) {
      if (pendingExplicitKey) {
        addEmptyScalarEvent(state);
        pendingExplicitKey = false;
      }
    }
    skipSeparationSpace(state, true);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === entryLine || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
    else if (state.lineIndent < nodeIndent) break;
  }
  if (!detected) return false;
  if (atExplicitKey) addEmptyScalarEvent(state);
  if (mappingOpened) addPopEvent(state);
  return true;
}
function parseNode(state, parentIndent, nodeContext, allowToSeek, allowCompact, allowPropertyMapping = true) {
  if (state.depth >= state.maxDepth) throwError(state, `nesting exceeded maxDepth (${state.maxDepth})`);
  state.depth++;
  let indentStatus = 1;
  let atNewLine = false;
  let hasContent = false;
  let propertyStart = null;
  const props = emptyProperties();
  let allowBlockScalars = nodeContext === CONTEXT_BLOCK_OUT || nodeContext === CONTEXT_BLOCK_IN;
  let allowBlockCollections = allowBlockScalars;
  const allowBlockStyles = allowBlockScalars;
  if (allowToSeek && skipSeparationSpace(state, true)) {
    atNewLine = true;
    if (state.lineIndent > parentIndent) indentStatus = 1;
    else if (state.lineIndent === parentIndent) indentStatus = 0;
    else indentStatus = -1;
  }
  if (indentStatus === 1) while (true) {
    const ch = state.input.charCodeAt(state.position);
    const propertyState = snapshotState(state);
    if (atNewLine && indentStatus !== 1 && (ch === 33 || ch === 38)) break;
    if (atNewLine && allowBlockStyles && (props.tagStart !== NO_RANGE$1 || props.anchorStart !== NO_RANGE$1) && (ch === 33 || ch === 38)) {
      const fallbackState = snapshotState(state);
      const flowIndent = parentIndent + 1;
      if (readBlockMapping(state, state.position - state.lineStart, flowIndent, props) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) {
        state.depth--;
        return true;
      }
      restoreState(state, fallbackState);
    }
    if (atNewLine && (ch === 33 && props.tagStart !== NO_RANGE$1 || ch === 38 && props.anchorStart !== NO_RANGE$1)) break;
    if (!readTagProperty(state, props, nodeContext === CONTEXT_FLOW_IN) && !readAnchorProperty(state, props)) break;
    if (propertyStart === null) propertyStart = propertyState;
    if (skipSeparationSpace(state, true)) {
      atNewLine = true;
      allowBlockCollections = allowBlockStyles;
      if (state.lineIndent > parentIndent) indentStatus = 1;
      else if (state.lineIndent === parentIndent) indentStatus = 0;
      else indentStatus = -1;
    } else allowBlockCollections = false;
  }
  if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
  if (indentStatus === 1 || nodeContext === CONTEXT_BLOCK_OUT) {
    const flowIndent = nodeContext === CONTEXT_FLOW_IN || nodeContext === CONTEXT_FLOW_OUT ? parentIndent : parentIndent + 1;
    const blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent, props) || readBlockMapping(state, blockIndent, flowIndent, props)) || readFlowCollection(state, flowIndent, props)) hasContent = true;
    else {
      const ch = state.input.charCodeAt(state.position);
      if (propertyStart !== null && allowPropertyMapping && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62) {
        const fallbackState = snapshotState(state);
        const propertyIndent = propertyStart.position - propertyStart.lineStart;
        restoreState(state, propertyStart);
        if (readBlockMapping(state, propertyIndent, flowIndent, emptyProperties()) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) hasContent = true;
        else restoreState(state, fallbackState);
      }
      if (!hasContent && (allowBlockScalars && readBlockScalar(state, flowIndent, props) || readSingleQuotedScalar(state, flowIndent, props) || readDoubleQuotedScalar(state, flowIndent, props) || readAlias(state, props) || readPlainScalar(state, flowIndent, nodeContext, props))) hasContent = true;
    }
    else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent, props);
  }
  allowBlockScalars = allowBlockScalars && !hasContent;
  if (!hasContent && (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1 || allowBlockScalars)) {
    addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN);
    hasContent = true;
  }
  state.depth--;
  return hasContent || props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1;
}
function readDirective(state) {
  if (state.lineIndent > 0 || state.input.charCodeAt(state.position) !== 37) return false;
  state.position++;
  const nameStart = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
  const name2 = state.input.slice(nameStart, state.position);
  const args = [];
  if (name2.length === 0) throwError(state, "directive name must not be less than one character in length");
  while (state.input.charCodeAt(state.position) !== 0 && !isEol(state.input.charCodeAt(state.position))) {
    while (isWhiteSpace(state.input.charCodeAt(state.position))) state.position++;
    if (state.input.charCodeAt(state.position) === 35 || isEol(state.input.charCodeAt(state.position)) || state.input.charCodeAt(state.position) === 0) break;
    const start = state.position;
    while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
    args.push(state.input.slice(start, state.position));
  }
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  if (name2 === "YAML") {
    if (state.directives.some((directive) => directive.kind === "yaml")) throwError(state, "duplication of %YAML directive");
    if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) throwError(state, "ill-formed argument of the YAML directive");
    if (parseInt(match[1], 10) !== 1) throwError(state, "unacceptable YAML version of the document");
    state.directives.push({
      kind: "yaml",
      version: args[0]
    });
  } else if (name2 === "TAG") {
    if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
    const [handle, prefix] = args;
    if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    if (HAS_OWN.call(state.tagHandlers, handle)) throwError(state, `there is a previously declared suffix for "${handle}" tag handle`);
    if (!PATTERN_TAG_PREFIX.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    state.tagHandlers[handle] = prefix;
    state.directives.push({
      kind: "tag",
      handle,
      prefix
    });
  }
  return true;
}
function readDocument(state) {
  state.directives = [];
  state.tagHandlers = /* @__PURE__ */ Object.create(null);
  let hasDirectives = false;
  skipSeparationSpace(state, true);
  while (readDirective(state)) {
    hasDirectives = true;
    skipSeparationSpace(state, true);
  }
  let explicitStart = false;
  let explicitEnd = false;
  let allowCompact = true;
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 3))) {
    explicitStart = true;
    const markerLine = state.line;
    state.position += 3;
    skipSeparationSpace(state, true);
    allowCompact = state.line > markerLine;
  } else if (hasDirectives) throwError(state, "directives end mark is expected");
  const documentEventIndex = state.events.length;
  if (!explicitStart && state.position === state.lineStart && state.input.charCodeAt(state.position) === 46 && testDocumentSeparator(state)) {
    state.position += 3;
    skipSeparationSpace(state, true);
    return;
  }
  addDocumentEvent(state, explicitStart, false);
  if (!parseNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, allowCompact, allowCompact)) addEmptyScalarEvent(state);
  skipSeparationSpace(state, true);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    explicitEnd = state.input.charCodeAt(state.position) === 46;
    if (explicitEnd) {
      const markerLine = state.line;
      state.position += 3;
      skipSeparationSpace(state, true);
      if (state.line === markerLine && state.position < state.length) throwError(state, "end of the stream or a document separator is expected");
    }
  }
  const documentEvent = state.events[documentEventIndex];
  if (documentEvent?.type === EVENT_ID.DOCUMENT) documentEvent.explicitEnd = explicitEnd;
  addPopEvent(state);
  if (!explicitEnd && state.position < state.length && !testDocumentBoundary(state)) throwError(state, "end of the stream or a document separator is expected");
}
function parseEvents(input, options) {
  const length = input.length;
  const state = {
    ...DEFAULT_PARSER_OPTIONS,
    ...options,
    input: `${input}\0`,
    length,
    position: 0,
    line: 0,
    lineStart: 0,
    lineIndent: 0,
    firstTabInLine: -1,
    depth: 0,
    directives: [],
    tagHandlers: /* @__PURE__ */ Object.create(null),
    events: []
  };
  const nullpos = input.indexOf("\0");
  if (nullpos !== -1) YAMLException.throwAt(input, nullpos, "null byte is not allowed in input", state.filename);
  while (state.position < state.length) {
    skipByteOrderMark(state);
    skipSeparationSpace(state, true);
    if (state.position >= state.length) break;
    const documentStart = state.position;
    readDocument(state);
    if (state.position === documentStart)
      throwError(state, "can not read a document");
  }
  return state.events;
}
var DEFAULT_LOAD_OPTIONS = {
  ...DEFAULT_PARSER_OPTIONS,
  ...DEFAULT_CONSTRUCTOR_OPTIONS
};
function loadDocuments(input, options = {}) {
  const opts = {
    ...DEFAULT_LOAD_OPTIONS,
    ...options
  };
  const source = String(input);
  const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS);
  const CONSTRUCTOR_OPT_KEYS = Object.keys(DEFAULT_CONSTRUCTOR_OPTIONS);
  return constructFromEvents(parseEvents(source, pick2(opts, PARSER_OPT_KEYS)), {
    ...pick2(opts, CONSTRUCTOR_OPT_KEYS),
    source
  });
}
function load(input, options) {
  const documents = loadDocuments(input, options);
  if (documents.length === 0) throw new YAMLException("expected a document, but the input is empty");
  if (documents.length === 1) return documents[0];
  throw new YAMLException("expected a single document in the stream, but found more");
}
function hasBit(mask, bit) {
  return (mask & 1 << bit) !== 0;
}
var DEFAULT_SCALAR_STYLE_RULES = {
  applyQuoteFlowKeysOption,
  doubleQuoteForInvisibles,
  doubleQuoteWhitespaceOnly,
  applyForceQuotesOption,
  tryLongOrMultilineAsBlock,
  quoteInvalidPlain,
  fallbackToDoubleQuoted
};
function _preferredQuotedStyle(layout) {
  if (layout.presenterOptions.quoteStyle === "single" && hasBit(layout.allowedStylesMask, SCALAR_STYLE.SINGLE_QUOTED)) return SCALAR_STYLE.SINGLE_QUOTED;
  return SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyQuoteFlowKeysOption(layout) {
  if (!layout.presenterOptions.quoteFlowKeys) return;
  if (!layout.isKey || !layout.flowOnly || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteForInvisibles(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /[\t\x7F-\xA0\u2028\u2029\uFEFF\uFFFE\uFFFF]/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteWhitespaceOnly(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /^\s+$/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyForceQuotesOption(layout) {
  if (!layout.presenterOptions.forceQuotes) return;
  if (layout.isKey || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = layout.node.value.includes("\n") ? SCALAR_STYLE.DOUBLE_QUOTED : _preferredQuotedStyle(layout);
}
function tryLongOrMultilineAsBlock(layout) {
  if (layout.style !== SCALAR_STYLE.PLAIN || layout.isKey) return;
  const value = layout.node.value;
  const multiline = value.indexOf("\n") !== -1;
  if (!hasBit(layout.allowedStylesMask, SCALAR_STYLE.LITERAL_BLOCK)) {
    if (multiline) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    return;
  }
  const w = layout.presenterOptions.lineWidth;
  if (w === -1) {
    if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
    return;
  }
  const availableWidth = Math.max(Math.min(w, 40), w - layout.shiftOfContent);
  let position = 0;
  let shouldFold = false;
  while (position <= value.length) {
    let lineEnd = value.length;
    const nextLineBreak = value.indexOf("\n", position);
    if (nextLineBreak !== -1) lineEnd = nextLineBreak;
    const line = value.slice(position, lineEnd);
    if (line.length > availableWidth && line[0] !== " " && / [^ \t]/.test(line)) shouldFold = true;
    if (nextLineBreak === -1) break;
    position = nextLineBreak + 1;
  }
  if (shouldFold) layout.style = SCALAR_STYLE.FOLDED_BLOCK;
  else if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
}
function quoteInvalidPlain(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && !hasBit(layout.allowedStylesMask, SCALAR_STYLE.PLAIN)) layout.style = _preferredQuotedStyle(layout);
}
function fallbackToDoubleQuoted(layout) {
  if (!hasBit(layout.allowedStylesMask, layout.style)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
var SRC_C_PRINTABLE = "[\\x09\\x0A\\x0D\\x20-\\x7E\\x85\\xA0-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]";
var SRC_B_CHAR = "[\\n\\r]";
var SRC_C_BYTE_ORDER_MARK = "\\uFEFF";
var SRC_S_WHITE = "[ \\t]";
var SRC_NB_CHAR = `(?:(?!(?:${SRC_B_CHAR}|${SRC_C_BYTE_ORDER_MARK}))${SRC_C_PRINTABLE})`;
var SRC_NS_CHAR = `(?:(?!${SRC_S_WHITE})${SRC_NB_CHAR})`;
var SRC_NB_JSON = "[\\x09\\x20-\\uD7FF\\uE000-\\uFFFF\\u{10000}-\\u{10FFFF}]";
var SRC_C_INDICATOR = "[-?:,\\[\\]{}#&*!|>'\"%@`]";
var SRC_C_FLOW_INDICATOR = "[,\\[\\]{}]";
var SRC_NS_PLAIN_SAFE_FLOW_OUT = SRC_NS_CHAR;
var SRC_NS_PLAIN_SAFE_FLOW_IN = `(?:(?!${SRC_C_FLOW_INDICATOR})${SRC_NS_CHAR})`;
var SRC_NS_PLAIN_FIRST_FLOW_OUT = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))`;
var SRC_NS_PLAIN_FIRST_FLOW_IN = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))`;
var SRC_NS_PLAIN_CHAR_FLOW_OUT = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_OUT})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))#*`;
var SRC_NS_PLAIN_CHAR_FLOW_IN = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_IN})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))#*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_OUT})*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_IN})*`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_OUT = `${SRC_NS_PLAIN_FIRST_FLOW_OUT}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_IN = `${SRC_NS_PLAIN_FIRST_FLOW_IN}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_OUT;
var SRC_NS_PLAIN_ONE_LINE_FLOW_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_IN;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_OUT}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_IN}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT = `${SRC_NS_PLAIN_ONE_LINE_FLOW_OUT}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT})*`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_IN = `${SRC_NS_PLAIN_ONE_LINE_FLOW_IN}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN})*`;
var NS_PLAIN_FLOW_OUT = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT})$`, "u");
var NS_PLAIN_FLOW_IN = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_IN})$`, "u");
var NS_PLAIN_BLOCK_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY})$`, "u");
var NS_PLAIN_FLOW_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_FLOW_KEY})$`, "u");
var NB_SINGLE_ONE_LINE = new RegExp(`^(?:${SRC_NB_JSON})*$`, "u");
var NB_SINGLE_MULTI_LINE = new RegExp(`^(?:${SRC_NB_JSON}|\\n)*$`, "u");
var BLOCK_SCALAR_CONTENT = new RegExp(`^(?:${SRC_NB_CHAR}|\\n)*$`, "u");
var DEFAULT_PRESENTER_OPTIONS = {
  indent: 2,
  seqNoIndent: false,
  seqInlineFirst: true,
  lineWidth: 80,
  flowBracketPadding: false,
  flowSkipCommaSpace: false,
  flowSkipColonSpace: false,
  quoteFlowKeys: false,
  quoteStyle: "single",
  forceQuotes: false,
  scalarStyleRules: Object.keys(DEFAULT_SCALAR_STYLE_RULES).map((name2) => Reflect.get(DEFAULT_SCALAR_STYLE_RULES, name2)),
  tagBeforeAnchor: false
};
var DEFAULT_DUMP_OPTIONS = {
  ...DEFAULT_PRESENTER_OPTIONS,
  schema: DUMP_SCHEMA,
  skipInvalid: false,
  noRefs: false,
  flowLevel: -1,
  sortKeys: false,
  transform: () => {
  }
};
var EVENT_DOCUMENT = EVENT_ID.DOCUMENT;
var EVENT_SEQUENCE = EVENT_ID.SEQUENCE;
var EVENT_MAPPING = EVENT_ID.MAPPING;
var EVENT_SCALAR = EVENT_ID.SCALAR;
var EVENT_ALIAS = EVENT_ID.ALIAS;
var EVENT_POP = EVENT_ID.POP;
var SCALAR_STYLE_PLAIN = SCALAR_STYLE.PLAIN;
var SCALAR_STYLE_SINGLE_QUOTED = SCALAR_STYLE.SINGLE_QUOTED;
var SCALAR_STYLE_DOUBLE_QUOTED = SCALAR_STYLE.DOUBLE_QUOTED;
var SCALAR_STYLE_LITERAL_BLOCK = SCALAR_STYLE.LITERAL_BLOCK;
var SCALAR_STYLE_FOLDED_BLOCK = SCALAR_STYLE.FOLDED_BLOCK;
var COLLECTION_STYLE_BLOCK = COLLECTION_STYLE.BLOCK;
var COLLECTION_STYLE_FLOW = COLLECTION_STYLE.FLOW;
var CHOMPING_CLIP = CHOMPING_MODE.CLIP;
var CHOMPING_STRIP = CHOMPING_MODE.STRIP;
var CHOMPING_KEEP = CHOMPING_MODE.KEEP;

// src/hermes/manifest.ts
var HERMES_SOURCE_APP = "hermes";
var HERMES_WANTS = [
  "SOUL.md",
  "memories/MEMORY.md",
  "memories/USER.md",
  "config.yaml",
  "cron/jobs.json",
  "skills/**"
];
var LIMITS = {
  soul: 2e5,
  memory: 4e3,
  memories: 256,
  skills: 200,
  companions: 200,
  routines: 64,
  routineName: 80,
  instruction: 1e5,
  mcpServers: 64,
  mcpArgs: 100,
  mcpArg: 4096,
  mcpCommand: 4096,
  url: 2048,
  secretNames: 64,
  secretName: 100,
  deliveries: 32,
  delivery: 100,
  model: 200,
  timezone: 64,
  warnings: 200,
  warning: 500,
  /** config.yaml is a settings file; past this it is not read. */
  configBytes: 1024 * 1024
};
var SKILL_FILE2 = "SKILL.md";
var BUNDLED_MANIFEST = "skills/.bundled_manifest";
var CODE_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl|php|exe|dll|so|dylib)$/i;
var scoped = (recorder, label) => (text) => recorder.warn(`${label}: ${text}`);
var decoder = new TextDecoder("utf-8", { fatal: true });
function textOf(bytes) {
  if (!bytes) return null;
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\0")) return null;
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  return text.replace(/\r\n?/g, "\n");
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var str = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
var clip2 = (text, max2) => text.length > max2 ? `${text.slice(0, max2 - 1)}\u2026` : text;
function soulText(raw) {
  const text = raw.replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
  if (!text) return null;
  const meaningful = text.split("\n").some((line) => line.trim() !== "" && !/^\s{0,3}#{1,6}(\s|$)/.test(line));
  return meaningful ? text : null;
}
function memoryEntries(raw) {
  return raw.split("\xA7").map((entry) => entry.trim()).filter((entry) => entry !== "");
}
function bundledNames(text) {
  const names = /* @__PURE__ */ new Set();
  for (const line of (text ?? "").split("\n")) {
    const at = line.lastIndexOf(":");
    const name2 = (at === -1 ? line : line.slice(0, at)).trim();
    if (name2) names.add(name2.toLowerCase());
  }
  return names;
}
function skillSlug(name2) {
  return name2.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "skill";
}
function findSkills(paths) {
  const found = [];
  for (const path of paths) {
    const parts = path.split("/");
    if (parts[0] !== "skills" || parts[parts.length - 1] !== SKILL_FILE2) continue;
    if (parts.length !== 3 && parts.length !== 4) continue;
    const folders = parts.slice(1, -1);
    if (folders.some((f) => f.startsWith("."))) continue;
    found.push({
      dir: parts.slice(0, -1).join("/"),
      name: folders[folders.length - 1],
      category: folders.length === 2 ? folders[0] : null
    });
  }
  return found;
}
function skillsOf(tree, warn) {
  const paths = [...tree.files.keys()];
  const bundled = bundledNames(textOf(tree.files.get(BUNDLED_MANIFEST)));
  const skills = [];
  const ids = /* @__PURE__ */ new Set();
  let skippedBundled = 0;
  for (const entry of tree.skipped) {
    if (entry.reason === "skill-too-large" && entry.path.startsWith("skills/")) {
      warn(`skill folder ${entry.path} is too large: not imported.`);
    }
  }
  for (const skill of findSkills(paths)) {
    if (bundled.has(skill.name.toLowerCase())) {
      skippedBundled += 1;
      continue;
    }
    if (skills.length >= LIMITS.skills) {
      warn(`more than ${LIMITS.skills} skills: ${skill.name} and the next ones are not imported.`);
      break;
    }
    const content = textOf(tree.files.get(`${skill.dir}/${SKILL_FILE2}`));
    if (content === null || !content.trim()) {
      warn(`skill ${skill.name} is not readable text: not imported.`);
      continue;
    }
    if (content.length > 1048576) {
      warn(`skill ${skill.name} is larger than 1 MiB: not imported.`);
      continue;
    }
    const prefix = `${skill.dir}/`;
    const companions = [];
    let hasCode = false;
    for (const path of paths) {
      if (!path.startsWith(prefix) || path === `${skill.dir}/${SKILL_FILE2}`) continue;
      const rel = path.slice(prefix.length);
      if (CODE_EXT.test(rel) || rel.split("/")[0] === "scripts") hasCode = true;
      if (isSafeRelativePath(rel) && companions.length < LIMITS.companions) companions.push(rel);
      else hasCode = true;
    }
    if (tree.skipped.some((s) => s.path.startsWith(prefix))) hasCode = true;
    let id = skillSlug(skill.name);
    if (ids.has(id) && skill.category) id = skillSlug(`${skill.category}-${skill.name}`);
    for (let n = 2; ids.has(id); n += 1) id = `${skillSlug(skill.name).slice(0, 95)}-${n}`;
    if (!SKILL_ID_RE.test(id)) continue;
    ids.add(id);
    skills.push({ id, content, ...companions.length > 0 ? { companionFiles: companions } : {}, ...hasCode ? { hasCode } : {} });
  }
  if (skippedBundled > 0) warn(`${skippedBundled} skills shipped with Hermes are not imported (Timon has its own).`);
  return skills;
}
function configOf(tree, warn) {
  const empty = { timezone: null, model: null, mcpServers: {} };
  const bytes = tree.files.get("config.yaml");
  if (!bytes) return empty;
  if (bytes.length > LIMITS.configBytes) {
    warn("config.yaml is too large to be read: MCP servers, model and time zone are not imported.");
    return empty;
  }
  const text = textOf(bytes);
  let doc;
  try {
    if (text === null) throw new Error("not text");
    doc = load(text, { schema: CORE_SCHEMA, maxAliases: 100, maxDepth: 64 });
  } catch {
    warn("config.yaml could not be read: MCP servers, model and time zone are not imported.");
    return empty;
  }
  if (!isRecord(doc)) return empty;
  let timezone = null;
  const tz = str(doc.timezone);
  if (tz && tz.length <= LIMITS.timezone && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) timezone = tz;
  let model = null;
  if (typeof doc.model === "string") model = str(doc.model);
  else if (isRecord(doc.model)) {
    const name2 = str(doc.model.default) ?? str(doc.model.model) ?? str(doc.model.name);
    const provider = str(doc.model.provider);
    model = name2 ? provider ? `${provider}/${name2}` : name2 : null;
  }
  return {
    timezone,
    model: model ? clip2(model, LIMITS.model) : null,
    mcpServers: isRecord(doc.mcp_servers) ? doc.mcp_servers : {}
  };
}
function namesOf(value) {
  return isRecord(value) ? Object.keys(value).filter((k) => k.trim() !== "") : [];
}
function mcpServersOf(config2, warn) {
  const servers = [];
  for (const [rawName, entry] of Object.entries(config2.mcpServers)) {
    const name2 = clip2(rawName.trim() || "mcp", 100);
    if (servers.length >= LIMITS.mcpServers) {
      warn(`more than ${LIMITS.mcpServers} MCP servers: ${name2} and the next ones are not imported.`);
      break;
    }
    if (!isRecord(entry)) {
      warn(`MCP server ${name2} is not a settings block: not imported.`);
      continue;
    }
    if (entry.enabled === false) {
      warn(`MCP server ${name2} is turned off in Hermes: not imported.`);
      continue;
    }
    const secrets = /* @__PURE__ */ new Set();
    for (const key of [...namesOf(entry.headers), ...namesOf(entry.env)]) secrets.add(key);
    const url = str(entry.url);
    const command = str(entry.command);
    if (url) {
      const clean = sanitizeUrl(url, secrets);
      if (!clean || clean.length > LIMITS.url) {
        warn(`MCP server ${name2} has no usable address: not imported.`);
        continue;
      }
      const names = [...secrets].map((s) => clip2(s, LIMITS.secretName)).slice(0, LIMITS.secretNames);
      servers.push({ name: name2, transport: "http", url: clean, ...names.length > 0 ? { secretNames: names } : {} });
      continue;
    }
    if (command) {
      const rawArgs = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
      const args = redactArgs(rawArgs.slice(0, LIMITS.mcpArgs), secrets).map((a) => clip2(a, LIMITS.mcpArg));
      const names = [...secrets].map((s) => clip2(s, LIMITS.secretName)).slice(0, LIMITS.secretNames);
      servers.push({
        name: name2,
        transport: "stdio",
        command: clip2(redactArgs([command], secrets)[0] ?? REDACTED, LIMITS.mcpCommand),
        ...args.length > 0 ? { args } : {},
        ...names.length > 0 ? { secretNames: names } : {}
      });
      continue;
    }
    warn(`MCP server ${name2} has neither an address nor a command: not imported.`);
  }
  return servers;
}
var DURATION = /^(\d{1,6})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
function minutesOf(text) {
  const m = DURATION.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  const minutes = unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 527040 ? minutes : null;
}
function onceOf(value) {
  const text = str(value);
  if (!text) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? { kind: "once", at: new Date(at).toISOString() } : null;
}
function hermesSchedule(value) {
  if (isRecord(value)) {
    if (value.kind === "cron") {
      const expr = str(value.expr) ?? str(value.expression);
      return expr && expr.length <= 200 ? { kind: "cron", expression: expr } : null;
    }
    if (value.kind === "interval") {
      const minutes2 = value.minutes;
      return typeof minutes2 === "number" && Number.isInteger(minutes2) && minutes2 >= 1 && minutes2 <= 527040 ? { kind: "interval", minutes: minutes2 } : null;
    }
    if (value.kind === "once") return onceOf(value.run_at ?? value.at);
    return null;
  }
  const text = str(value);
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length >= 5 && parts.length <= 6 && parts.slice(0, 5).every((p) => /^[A-Za-z\d*,/-]+$/.test(p))) {
    return text.length <= 200 ? { kind: "cron", expression: text } : null;
  }
  const every = /^every\s+(.+)$/i.exec(text);
  const minutes = minutesOf(every ? every[1] : text);
  if (minutes !== null) return { kind: "interval", minutes };
  return onceOf(text);
}
function deliveriesOf(job) {
  const out = [];
  const deliver = typeof job.deliver === "string" ? job.deliver : "";
  for (const part of deliver.split(",")) {
    let platform = part.trim().split(":")[0].trim().toLowerCase();
    if (!platform || platform === "local") continue;
    if (platform === "origin") {
      const origin = isRecord(job.origin) ? str(job.origin.platform) : null;
      platform = origin ? origin.toLowerCase() : "origin";
    }
    out.push(clip2(platform, LIMITS.delivery));
  }
  return out;
}
function routinesOf(tree, timezone, warn) {
  const routines = [];
  const deliveries = /* @__PURE__ */ new Set();
  const bytes = tree.files.get("cron/jobs.json");
  if (!bytes) return { routines, deliveries: [] };
  const text = textOf(bytes);
  let data;
  try {
    if (text === null) throw new Error("not text");
    data = JSON.parse(text);
  } catch {
    warn("cron/jobs.json could not be read: the scheduled jobs are not imported.");
    return { routines, deliveries: [] };
  }
  const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : null;
  if (!jobs) {
    warn("cron/jobs.json holds no job list: the scheduled jobs are not imported.");
    return { routines, deliveries: [] };
  }
  let index = 0;
  for (const job of jobs) {
    index += 1;
    if (!isRecord(job)) continue;
    const name2 = clip2(str(job.name) ?? str(job.id) ?? `Job ${index}`, LIMITS.routineName);
    for (const platform of deliveriesOf(job)) deliveries.add(platform);
    if (job.no_agent === true || str(job.script)) {
      warn(`job "${name2}" runs a script: not imported (Timon does not run imported scripts).`);
      continue;
    }
    const prompt = typeof job.prompt === "string" ? job.prompt.replace(/\r\n?/g, "\n").trim() : "";
    if (!prompt) {
      warn(`job "${name2}" has no instruction: not imported.`);
      continue;
    }
    if (prompt.length > LIMITS.instruction) {
      warn(`job "${name2}" has an instruction longer than ${LIMITS.instruction} characters: not imported.`);
      continue;
    }
    const schedule = hermesSchedule(job.schedule);
    if (!schedule) {
      warn(`job "${name2}" has a schedule Timon cannot read: not imported.`);
      continue;
    }
    if (routines.length >= LIMITS.routines) {
      warn(`more than ${LIMITS.routines} jobs: "${name2}" and the next ones are not imported.`);
      break;
    }
    const skills = Array.isArray(job.skills) ? job.skills.filter((s) => typeof s === "string") : [];
    if (skills.length > 0) warn(`job "${name2}" preloads skills (${clip2(skills.join(", "), 200)}): the routine does not.`);
    if (isRecord(job.repeat) && typeof job.repeat.times === "number") {
      warn(`job "${name2}" runs a limited number of times in Hermes: in Timon it repeats until turned off.`);
    }
    const state = str(job.state);
    routines.push({
      name: name2,
      instruction: prompt,
      schedule,
      timezone,
      enabledInSource: job.enabled !== false && state !== "paused" && state !== "completed"
    });
  }
  return { routines, deliveries: [...deliveries].slice(0, LIMITS.deliveries) };
}
function keyOf(name2, taken) {
  const base = name2.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "profile";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}
var REPORTED = /* @__PURE__ */ new Set(["link", "hard-link", "special", "too-large", "unportable-name", "case-collision"]);
function agentOf(profile, key, warnings) {
  const isDefault = profile.name === "default";
  const displayName = isDefault ? "Hermes" : clip2(profile.name, 100);
  const warn = scoped(warnings, displayName);
  const tree = profile.tree;
  const left = tree.skipped.filter((s) => REPORTED.has(s.reason) && !s.path.startsWith("skills/"));
  if (left.length > 0) {
    const listed = left.slice(0, 10).map((s) => `${s.path} (${s.reason})`).join(", ");
    warn(`left out: ${listed}${left.length > 10 ? ", \u2026" : ""}.`);
  }
  let soul = null;
  const soulBytes = tree.files.get("SOUL.md");
  if (soulBytes) {
    const raw = textOf(soulBytes);
    if (raw === null) warn("SOUL.md is not readable text: not imported.");
    else {
      soul = soulText(raw);
      if (soul && soul.length > LIMITS.soul) {
        warn(`SOUL.md is longer than ${LIMITS.soul} characters: not imported.`);
        soul = null;
      }
    }
  }
  const memories = [];
  for (const [file, kind] of [["memories/USER.md", "preference"], ["memories/MEMORY.md", "decision"]]) {
    const bytes = tree.files.get(file);
    if (!bytes) continue;
    const raw = textOf(bytes);
    if (raw === null) {
      warn(`${file} is not readable text: not imported.`);
      continue;
    }
    for (const text of memoryEntries(raw)) {
      if (text.length > LIMITS.memory) {
        warn(`an entry of ${file} is longer than ${LIMITS.memory} characters: not imported.`);
        continue;
      }
      if (memories.length >= LIMITS.memories) break;
      memories.push({ text, kind });
    }
  }
  const config2 = configOf(tree, warn);
  const skills = skillsOf(tree, warn);
  const mcpServers = mcpServersOf(config2, warn);
  const { routines, deliveries } = routinesOf(tree, config2.timezone, warn);
  if (profile.envSkipped) warn(`.env was not read (${profile.envSkipped}): its variable names are not listed.`);
  if (profile.envTruncated) warn(`.env names more than ${LIMITS.secretNames} variables: only the first ones are listed.`);
  const secretNames = [...new Set(profile.envNames)].slice(0, LIMITS.secretNames).map((n) => clip2(n, LIMITS.secretName));
  const hints = {
    ...config2.model ? { model: config2.model } : {},
    ...deliveries.length > 0 ? { deliveries } : {},
    ...secretNames.length > 0 ? { secretNames } : {},
    ...profile.hasHistory ? { hasHistory: true } : {}
  };
  return {
    key,
    displayName,
    soul,
    instructions: null,
    ...memories.length > 0 ? { memories } : {},
    ...skills.length > 0 ? { skills } : {},
    ...routines.length > 0 ? { routines } : {},
    ...mcpServers.length > 0 ? { mcpServers } : {},
    ...Object.keys(hints).length > 0 ? { hints } : {},
    sourceRef: `profile:${profile.name}`
  };
}
function hermesToManifest(profiles, options = {}) {
  const warnings = [];
  const recorder = {
    warn(text) {
      if (warnings.length < LIMITS.warnings) warnings.push(clip2(text, LIMITS.warning));
    }
  };
  const taken = /* @__PURE__ */ new Set();
  const agents = profiles.slice(0, 100).map((profile) => agentOf(profile, keyOf(profile.name, taken), recorder));
  if (profiles.length > 100) recorder.warn(`Hermes has more than 100 profiles: only the first 100 are imported.`);
  return parseManifest({
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: { app: HERMES_SOURCE_APP, exportedAt: options.exportedAt ?? null },
    agents,
    ...warnings.length > 0 ? { warnings } : {}
  });
}

// src/hermes/source.ts
async function present(path) {
  try {
    await lstat4(path);
    return true;
  } catch {
    return false;
  }
}
async function readHermesProfile(profile) {
  const tree = await readDirSource(profile.root, HERMES_WANTS);
  const env = await readEnvNames(profile.root);
  const hasHistory = await present(join4(profile.root, "state.db")) || await present(join4(profile.root, "sessions"));
  return {
    name: profile.name,
    tree,
    envNames: env.names,
    envSkipped: env.skipped,
    envTruncated: env.truncated,
    hasHistory
  };
}
async function readHermesManifest(installation, names, now = () => /* @__PURE__ */ new Date()) {
  const wanted = names ? new Set(names) : null;
  const profiles = installation.profiles.filter((p) => !wanted || wanted.has(p.name));
  const inputs = [];
  for (const profile of profiles) inputs.push(await readHermesProfile(profile));
  return hermesToManifest(inputs, { exportedAt: now().toISOString() });
}

// src/export.ts
import { randomBytes } from "node:crypto";
var EXPORT_MAX_AGENTS = 100;
var ExportError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ExportError";
  }
  code;
};
var INSTANCE_KEY = "export:instance";
var WARNINGS_MAX2 = 200;
var WARNING_CHARS2 = 500;
var TEXT_MAX = 2e5;
var ROUTINE_NAME_MAX = 80;
var ROUTINE_PROMPT_MAX2 = 1e5;
var SKILL_MAX = 1048576;
var AVATAR_CHARS_MAX = 28e5;
var RULE_KINDS = /* @__PURE__ */ new Set(["preference", "decision", "pitfall"]);
async function instanceId(ctx) {
  const stored = await ctx.storage.kv.get(INSTANCE_KEY);
  if (typeof stored === "string" && /^[a-f0-9]{16}$/.test(stored)) return stored;
  const fresh = randomBytes(8).toString("hex");
  await ctx.storage.kv.set(INSTANCE_KEY, fresh);
  return fresh;
}
function keyOf2(name2, taken) {
  const base = name2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "") || "agent";
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? "" : `-${n}`;
    const key = `${base.slice(0, 64 - tail.length).replace(/-+$/, "")}${tail}`;
    if (SOURCE_KEY_RE.test(key) && !taken.has(key)) {
      taken.add(key);
      return key;
    }
  }
}
function publicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const stripped = url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return { url: url.href, stripped };
}
var clip3 = (text, max2) => text.length > max2 ? `${text.slice(0, max2 - 1)}\u2026` : text;
function stamp(date3) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date3.getFullYear()}${p(date3.getMonth() + 1)}${p(date3.getDate())}-${p(date3.getHours())}${p(date3.getMinutes())}${p(date3.getSeconds())}`;
}
async function buildExport(ctx, request, now = /* @__PURE__ */ new Date()) {
  const visible = await ctx.agents.list();
  const byLower = new Map(visible.map((a) => [a.name.toLowerCase(), a.name]));
  let names;
  if ("all" in request) {
    names = visible.map((a) => a.name);
  } else {
    names = [];
    for (const asked of request.agents) {
      const name2 = byLower.get(asked.toLowerCase());
      if (!name2) throw new ExportError("not_found", `No agent named ${clip3(asked, 100)}.`);
      if (!names.includes(name2)) names.push(name2);
    }
  }
  if (names.length === 0) throw new ExportError("invalid", "There is no agent to export.");
  if (names.length > EXPORT_MAX_AGENTS) {
    throw new ExportError("too_many", `An archive holds ${EXPORT_MAX_AGENTS} agents at most: export them in several parts.`);
  }
  const instance = await instanceId(ctx);
  const warnings = [];
  const warn = (text2) => {
    if (warnings.length < WARNINGS_MAX2) warnings.push(clip3(text2, WARNING_CHARS2));
  };
  const keys = /* @__PURE__ */ new Set();
  const agents = [];
  const teams = /* @__PURE__ */ new Map();
  const groupKeys = /* @__PURE__ */ new Set();
  for (const name2 of names) {
    const def = await ctx.agents.export(name2);
    const key = keyOf2(def.name, keys);
    let systemPrompt = def.systemPrompt;
    if (systemPrompt.length > TEXT_MAX) {
      warn(`${def.name}: its instructions are longer than ${TEXT_MAX} characters and are cut.`);
      systemPrompt = systemPrompt.slice(0, TEXT_MAX);
    }
    const docs = [];
    for (const doc of def.docs) {
      if (!DOC_NAME_RE.test(doc.name) || !doc.content.trim()) continue;
      if (doc.content.length > TEXT_MAX) {
        warn(`${def.name}: ${doc.name} is longer than ${TEXT_MAX} characters, left out.`);
        continue;
      }
      if (docs.length >= 32) {
        warn(`${def.name}: more than 32 identity documents, ${doc.name} is left out.`);
        continue;
      }
      docs.push({ name: doc.name, content: doc.content });
    }
    const memories = [];
    try {
      for (const rule of await ctx.memory.rules.list({ scope: "agent", agent: def.name })) {
        if (rule.status !== "active" || !RULE_KINDS.has(rule.kind) || rule.text.length > 4e3) continue;
        if (memories.length >= 256) break;
        memories.push({ text: rule.text, kind: rule.kind });
      }
    } catch {
      warn(`${def.name}: its memory rules could not be read, left out.`);
    }
    const skills = [];
    for (const id of def.skills) {
      const skill = SKILL_ID_RE.test(id) ? await ctx.skills.get(id).catch(() => void 0) : void 0;
      if (!skill) {
        warn(`${def.name}: skill ${clip3(id, 100)} could not be read, left out.`);
        continue;
      }
      if (skill.product) {
        warn(`${def.name}: skill ${id} ships with Timon, attach it again on the other side.`);
        continue;
      }
      if (!skill.content.trim() || skill.content.length > SKILL_MAX) {
        warn(`${def.name}: skill ${id} is empty or too large, left out.`);
        continue;
      }
      skills.push({ id, content: skill.content });
    }
    const mcpServers = [];
    for (const id of def.mcpServers) {
      const server = await ctx.mcpServers.get(id).catch(() => void 0);
      if (!server) {
        warn(`${def.name}: MCP server ${clip3(id, 100)} could not be read, left out.`);
        continue;
      }
      const label = clip3(server.name ?? server.id, 100);
      const transport = server.transport;
      if (transport.type === "http") {
        const address = publicUrl(transport.url);
        if (!address) {
          warn(`${def.name}: MCP server ${label} has no usable address, left out.`);
          continue;
        }
        const secretNames = Object.keys(transport.headers ?? {}).slice(0, 64);
        if (address.stripped) warn(`${def.name}: MCP server ${label}: the query string of its address may hold a key, it is left out.`);
        if (transport.oauth) warn(`${def.name}: MCP server ${label} signs in with OAuth: sign in again on the other side.`);
        mcpServers.push({ name: label, transport: "http", url: address.url, ...secretNames.length ? { secretNames } : {} });
      } else if (transport.type === "stdio") {
        const secretNames = Object.keys(transport.env ?? {}).slice(0, 64);
        mcpServers.push({ name: label, transport: "stdio", ...secretNames.length ? { secretNames } : {} });
      } else {
        warn(`${def.name}: MCP server ${label} is an account connector, not carried over.`);
      }
    }
    const routines = [];
    for (const routine of def.routines) {
      if (!routine.prompt.trim() || routine.prompt.length > ROUTINE_PROMPT_MAX2) {
        warn(`${def.name}: routine "${clip3(routine.name, ROUTINE_NAME_MAX)}" has an empty or too long instruction, left out.`);
        continue;
      }
      if (routines.length >= 64) break;
      routines.push({
        name: clip3(routine.name, ROUTINE_NAME_MAX) || "Routine",
        instruction: routine.prompt,
        schedule: { kind: "cron", expression: clip3(routine.cron, 200) },
        timezone: routine.tz,
        enabledInSource: routine.enabled
      });
    }
    let avatar = null;
    if (def.avatar) {
      if (def.avatar.data.length <= AVATAR_CHARS_MAX) avatar = { mime: def.avatar.mime, dataBase64: def.avatar.data };
      else warn(`${def.name}: its picture is too large, left out.`);
    }
    if (def.team) {
      const entry = teams.get(def.team.id) ?? {
        group: { key: keyOf2(def.team.name, groupKeys), name: clip3(def.team.name, 160), color: def.team.color, members: [] },
        members: []
      };
      entry.members.push(key);
      teams.set(def.team.id, entry);
    }
    agents.push({
      key,
      displayName: clip3(def.name, 100),
      instructions: systemPrompt,
      ...def.directives ? { directives: def.directives.slice(0, 2e4) } : {},
      ...docs.length ? { docs } : {},
      ...memories.length ? { memories } : {},
      ...skills.length ? { skills } : {},
      ...routines.length ? { routines } : {},
      ...mcpServers.length ? { mcpServers } : {},
      avatar,
      hints: {
        ...def.backend ? { backend: def.backend.slice(0, 64) } : {},
        ...def.model ? { model: def.model.slice(0, 200) } : {},
        ...def.role ? { role: def.role.slice(0, 32) } : {},
        ...def.project ? { project: def.project.slice(0, 200) } : {},
        ...def.cwd ? { cwd: def.cwd.slice(0, 4096) } : {},
        ...def.main ? { main: true } : {}
      },
      sourceRef: exportSourceRef(instance, def)
    });
  }
  const groups = [...teams.values()].map(({ group, members: members2 }) => ({ ...group, members: members2 }));
  const draft = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: { app: EXPORT_SOURCE_APP, exportedAt: now.toISOString() },
    agents,
    ...groups.length ? { groups } : {},
    ...warnings.length ? { warnings } : {}
  };
  let manifest = parseManifest(draft);
  let text = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES && agents.some((a) => a.avatar)) {
    manifest = parseManifest({
      ...draft,
      agents: agents.map((a) => ({ ...a, avatar: null })),
      warnings: [...warnings, "The archive was too large with the pictures: they are left out."].slice(0, WARNINGS_MAX2)
    });
    text = JSON.stringify(manifest, null, 2);
  }
  if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) {
    throw new ExportError("too_large", "These agents do not fit in one archive: export them in several parts.");
  }
  const archive = zipSync({ [MANIFEST_FILE]: strToU8(text) }, { level: 6, mtime: now });
  return { manifest, archive, fileName: `timon-agents-${stamp(now)}.zip` };
}

// skills/timon-export/SKILL.md
var SKILL_default = '---\nname: timon-export\ndescription: Export your agents (Hermes profiles, Grok Bot Bots and groups, or yourself) into one zip that Timon imports. Use when the user asks to export their agents for Timon, to move their agents to Timon, or to make a Timon agent archive.\n---\n\n# Export agents for Timon\n\nYou are about to pack the user\'s agents into **one `.zip` file** that Timon\nreads in **Import agents \u203A Grok Bot, Hermes or another agent**. The archive\nholds a single JSON file, `timon-agent-import.json`, in the exact format\ndescribed below. Timon shows the user a preview of everything before it\nwrites anything.\n\n## Rules that never bend\n\n- **No secret value, ever.** API keys, tokens, passwords, cookies, session\n  ids, private URLs with credentials: never copy their value anywhere in the\n  archive, not even in a warning. A secret travels by its **name** only\n  (`OPENAI_API_KEY`, `Authorization`), in a `secretNames` list.\n- **Read, do not change.** You only read the user\'s agents. Do not edit,\n  move or delete anything of theirs, and do not run their scripts.\n- **Ask before you pack.** List what you found and let the user choose.\n- **The format is strict.** Every object accepts only the fields listed here.\n  An unknown field, a wrong type or a value past its limit makes Timon refuse\n  the whole archive. Leave a field out rather than guess.\n\n## Step 1 \u2014 Find the agents\n\n### In Hermes\n\n1. Find the **standard folder**: `~/.hermes` on Linux and macOS,\n   `%LOCALAPPDATA%\\hermes` on Windows (then `%USERPROFILE%\\.hermes` if that\n   one does not exist).\n2. Find the **active folder**, the profile you run in: the folder named by\n   the `HERMES_HOME` environment variable when it is set, otherwise the\n   standard folder. Hermes started on a named profile (`hermes -p work`) sets\n   `HERMES_HOME` to that profile\'s folder, not to the root.\n3. Find the **root**, the folder that holds every profile, as Hermes does:\n   - no `HERMES_HOME`, or a `HERMES_HOME` inside the standard folder\n     (`~/.hermes/profiles/work`): the standard folder;\n   - otherwise, a `HERMES_HOME` of the form `<folder>/profiles/<name>`:\n     `<folder>`;\n   - otherwise: `HERMES_HOME` itself.\n4. Each profile is one agent. The root itself is the profile `default`; each\n   folder `<root>/profiles/<name>` is the profile `<name>`. Skip the names\n   found in `<root>/profiles/.deleted`. Name a profile by **its folder**,\n   never by the folder you run in: when the active folder is\n   `<root>/profiles/work`, you are `work`, not `default`. List every profile\n   of the root, and say which one is active.\n5. Per profile, read only these files (paths relative to the profile folder):\n   - `SOUL.md`: the identity. Drop its HTML comments (`<!-- \u2026 -->`); if only\n     headings are left, it is empty.\n   - `memories/USER.md` and `memories/MEMORY.md`: entries separated by `\xA7`.\n     Each non-empty entry is one memory: `preference` for `USER.md`,\n     `decision` for `MEMORY.md`.\n   - `skills/<name>/SKILL.md` and `skills/<category>/<name>/SKILL.md`: one\n     skill each. Skip hidden folders and the skills named in\n     `skills/.bundled_manifest` (one `name:hash` per line, shipped with Hermes).\n   - `cron/jobs.json`: the scheduled jobs (a list, or `{ "jobs": [...] }`).\n   - `config.yaml`: `model` (a string, or `{ provider, default }` \u2192\n     `provider/default`), `timezone`, and `mcp_servers`.\n   - `.env`: the variable **names** only, never the values.\n   - Whether `state.db` or `sessions/` exists: that is a history, which Timon\n     does not import (`hints.hasHistory: true`).\n\n### In Grok Bot\n\n1. List the Bots and the groups you can see: for each Bot its name, title,\n   description (its job), its instructions, the skills it uses, its routines\n   (instruction, when to run, time zone, paused or active), what it remembers,\n   and its picture if you can read it. For each group: its name and members.\n2. If you can only see yourself, export yourself, and tell the user to ask\n   each other Bot the same thing. Timon imports several archives one after\n   the other.\n3. A routine started by an event (Slack, email, GitHub, a webhook\u2026) cannot be\n   carried: name it in `warnings`.\n\n### In any other agent tool\n\nExport yourself: your name, your role or title, your identity and\ninstructions, what you remember about the user, your text skills, your\nscheduled tasks and your MCP servers.\n\n## Step 2 \u2014 Ask which agents to export\n\nShow the user the list (name and one line each) and ask which ones to export:\nall of them, or some. Export only what they chose.\n\n## Step 3 \u2014 Write the manifest\n\nOne JSON object, UTF-8, at most **10 MiB**. Its top level:\n\n| Field | Value |\n|---|---|\n| `format` | always `"timon-agent-import"` |\n| `version` | always `1` |\n| `source` | `{ "app": "<app>", "exportedAt": "<now, ISO 8601 with offset>" }`. `app` is `"hermes"` for Hermes, `"grok-bot"` for Grok Bot, otherwise a short lowercase name of your tool (`a-z`, `0-9`, `-`). Timon names the agents `<app>.<key>`. |\n| `agents` | 1 to 100 agents (below). |\n| `groups` | optional, up to 100 groups (below). |\n| `warnings` | optional, up to 200 sentences of at most 500 characters: what you could not carry, in plain words. |\n\n### An agent\n\n| Field | Required | Value |\n|---|---|---|\n| `key` | yes | lowercase `a-z`, `0-9` and `-`, 1 to 64 characters, starting and ending with a letter or digit. Unique in the manifest. |\n| `displayName` | yes | 1 to 100 characters. |\n| `sourceRef` | yes | the agent\'s stable id at the source, unique, at most 300 characters. Always the same for the same agent: Timon updates the agent it already imported instead of creating a copy. |\n| `title` | no | at most 120 characters. |\n| `soul` | no | who the agent is (becomes its `SOUL.md`), at most 200,000 characters. |\n| `instructions` | no | its working instructions (its system prompt), at most 200,000 characters. |\n| `directives` | no | extra directives, at most 20,000 characters. |\n| `docs` | no | up to 32 documents `{ "name", "content" }`: `name` ends in `.md` (letters, digits, `_`, `.`, `-`, at most 99 characters, not `system-prompt.md`), `content` 1 to 200,000 characters. Names are unique. |\n| `memories` | no | up to 256 `{ "text", "kind" }`: `text` 1 to 4,000 characters, `kind` one of `preference`, `decision`, `pitfall`. |\n| `skills` | no | up to 200 `{ "id", "content" }` (below). |\n| `routines` | no | up to 64 routines (below). |\n| `mcpServers` | no | up to 64 servers (below). |\n| `avatar` | no | `{ "mime", "dataBase64" }`: `mime` one of `image/png`, `image/jpeg`, `image/webp`, `image/gif`; the picture in standard base64 (no `data:` prefix, no line breaks), at most 2 MiB once decoded. |\n| `hints` | no | `{ "model", "deliveries", "secretNames", "hasHistory" }`, all optional: `model` at most 200 characters; `deliveries` up to 32 platform names (`telegram`, `discord`\u2026); `secretNames` up to 64 names of the secrets the agent used; `hasHistory` `true` when there is a conversation history. |\n\nA **skill** is `{ "id", "content" }` and, when the skill folder holds more\nthan its `SKILL.md`, `"companionFiles"` (their relative paths, up to 200) and\n`"hasCode": true` when one of them is a script. `id` is lowercase `a-z`,\n`0-9`, `.`, `_`, `-`, 1 to 100 characters (the folder name, lowercased);\n`content` is the whole `SKILL.md` text, at most 1 MiB. Timon imports\ntext-only skills and lists the others.\n\nA **routine** is `{ "name", "instruction", "schedule", "timezone",\n"enabledInSource" }`: `name` 1 to 80 characters, `instruction` (what the agent\nis asked to do) 1 to 100,000 characters, `timezone` an IANA zone such as\n`Europe/Paris` or `null`, `enabledInSource` `true` when it is active at the\nsource. Leave out a job that runs a script instead of asking the agent. The\n`schedule` is exactly one of:\n\n| `schedule` | Meaning |\n|---|---|\n| `{ "kind": "cron", "expression": "0 9 * * 1-5" }` | a 5-field cron expression |\n| `{ "kind": "interval", "minutes": 120 }` | every N minutes, 1 to 527,040 |\n| `{ "kind": "hourly", "minute": 15 }` | every hour at that minute (`minute` optional, 0\u201359) |\n| `{ "kind": "daily", "time": "08:00" }` | every day, `HH:MM` 24-hour |\n| `{ "kind": "weekdays", "time": "08:00" }` | Monday to Friday |\n| `{ "kind": "weekly", "days": ["mon", "thu"], "time": "18:30" }` | 1 to 7 days: `sun`\u2026`sat`, full names, or 0\u20137 (0 and 7 are Sunday) |\n| `{ "kind": "monthly", "day": 1, "time": "09:00" }` | day 1 to 31 of each month |\n| `{ "kind": "once", "at": "2026-12-24T18:00:00+01:00" }` | one run, ISO 8601 with offset (shown, not scheduled) |\n\nAn **MCP server** is `{ "name", "transport", \u2026 }`: `name` 1 to 100\ncharacters, `transport` `"http"` or `"stdio"`. An `http` server has `url`\n(at most 2,048 characters) **without** user name, password, or any query\nparameter or path segment that holds a secret. A `stdio` server has\n`command` and `args` with every secret value replaced by `<redacted>`. In\nboth, `secretNames` lists the names of the headers and environment variables\nit needs. Leave out a server that is turned off.\n\n### A group\n\n`{ "key", "name", "members", "color" }`: `key` like an agent key, `name` 1 to\n160 characters, `members` the `key`s of agents **in this manifest** (up to\n100), `color` optional. Timon makes each group a team. A group\'s lead, own\ninstructions, routines and memories have no place there: say so in\n`warnings`.\n\n### How each source fills it\n\n| | Hermes | Grok Bot |\n|---|---|---|\n| `source.app` | `hermes` | `grok-bot` |\n| `key` | the profile name, lowercased, every run of other characters turned into `-` (`default` stays `default`) | the Bot\'s name, the same way |\n| `displayName` | `Hermes` for `default`, the profile name otherwise | the Bot\'s name |\n| `sourceRef` | `profile:<profile name>`, the name its folder gives it in step 1 (`default` only for the root) | `grok-bot:<the Bot\'s id, or its key>` |\n| `soul` | `SOUL.md` without comments | name, title and description |\n| `memories` | `USER.md` \u2192 `preference`, `MEMORY.md` \u2192 `decision` | what it remembers \u2192 `preference` |\n| `routines` | `cron/jobs.json`: `prompt` \u2192 `instruction`; `schedule` `{kind: cron, expr}` \u2192 `cron`, `{kind: interval, minutes}` \u2192 `interval`; `enabled` and `state` \u2192 `enabledInSource`; the `timezone` of `config.yaml` | its routines, their time zone, active or paused |\n| `mcpServers` | `mcp_servers` of `config.yaml` | the apps it uses, when they are MCP servers |\n| `hints.secretNames` | the names in `.env` | the names of the secrets it uses |\n\n## Step 4 \u2014 Check it\n\nBefore you pack, check every rule above: no unknown field, every required\nfield present, the limits respected, keys and `sourceRef`s unique, every\ngroup member a key of the manifest. Search the whole JSON one last time for a\nsecret value: there must be none. If the file is over 10 MiB, drop the\npictures first.\n\n## Step 5 \u2014 Make the zip\n\nName it `timon-agents-<app>-<YYYY-MM-DD>.zip` (`timon-agents-hermes-2026-11-03.zip`),\nwith `-2`, `-3`\u2026 when that name is taken. `timon-agent-import.json` sits at\nthe **root** of the zip, not in a folder.\n\nPut it in the user\'s Downloads folder: `~/Downloads` on macOS, Windows\n(`%USERPROFILE%\\Downloads`) and Linux (or the folder `xdg-user-dir DOWNLOAD`\nprints). Write it as `<name>.zip.part` first, then rename it to `<name>.zip`,\nso that Timon never sees a half-written file. With Python:\n\n```python\nimport os, zipfile\ntarget = os.path.join(downloads, name)   # downloads and name chosen above\nwith zipfile.ZipFile(target + ".part", "w", zipfile.ZIP_DEFLATED) as zf:\n    zf.writestr("timon-agent-import.json", manifest_json)   # the text, UTF-8\nos.replace(target + ".part", target)\n```\n\n**You work on a computer that is not the user\'s** (Grok Bot\'s cloud computer,\na remote server): make the zip there, then attach it to the conversation so\nthe user downloads it.\n\n## Step 6 \u2014 Tell the user\n\nSay where the zip is, how many agents it holds, and what you left out. Then:\nin Timon, **Import agents**, the card **Grok Bot, Hermes or another agent**,\npick the zip, check the preview, then import. From a terminal:\n`timon agent import <the zip>`. The secrets have to be entered again in Timon:\nlist their names.\n\n## Example manifest\n\nA complete, valid manifest (a Grok Bot export of two Bots and their group):\n\n<!-- timon-export:example -->\n```json\n{\n  "format": "timon-agent-import",\n  "version": 1,\n  "source": { "app": "grok-bot", "exportedAt": "2026-11-03T18:30:00+01:00" },\n  "agents": [\n    {\n      "key": "ada",\n      "displayName": "Ada",\n      "title": "Daily tech scout",\n      "sourceRef": "grok-bot:ada",\n      "soul": "Ada scouts new developer tools and explains them in plain words.",\n      "instructions": "Each weekday, read the bookmarks, pick one tool worth a demo and draft a short note about it. Ask before sending anything.",\n      "docs": [{ "name": "STYLE.md", "content": "Short sentences. One example per idea." }],\n      "memories": [\n        { "text": "The user reads the morning note on the phone.", "kind": "preference" },\n        { "text": "Notes go to the #tech channel, never to customers.", "kind": "decision" }\n      ],\n      "skills": [\n        {\n          "id": "weekly-digest",\n          "content": "---\\nname: weekly-digest\\ndescription: Sum up the week\'s notes in five lines.\\n---\\n\\nRead this week\'s notes and write five lines, one per day.\\n"\n        }\n      ],\n      "routines": [\n        {\n          "name": "Morning note",\n          "instruction": "Pick one tool from the bookmarks and draft the morning note.",\n          "schedule": { "kind": "weekdays", "time": "08:00" },\n          "timezone": "Europe/Paris",\n          "enabledInSource": true\n        },\n        {\n          "name": "Inbox sweep",\n          "instruction": "List the unread mentions and suggest a reply for each.",\n          "schedule": { "kind": "interval", "minutes": 120 },\n          "timezone": null,\n          "enabledInSource": false\n        }\n      ],\n      "mcpServers": [\n        { "name": "notes", "transport": "http", "url": "https://mcp.example.com/notes", "secretNames": ["Authorization"] }\n      ],\n      "avatar": {\n        "mime": "image/png",\n        "dataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="\n      },\n      "hints": { "model": "grok-4", "deliveries": ["slack"], "secretNames": ["GITHUB_TOKEN"] }\n    },\n    {\n      "key": "max",\n      "displayName": "Max",\n      "sourceRef": "grok-bot:max",\n      "soul": "Max reviews the drafts before they go out.",\n      "routines": [\n        {\n          "name": "Friday review",\n          "instruction": "Review the drafts of the week and list what to fix.",\n          "schedule": { "kind": "weekly", "days": ["fri"], "time": "16:00" },\n          "timezone": "Europe/Paris",\n          "enabledInSource": true\n        }\n      ]\n    }\n  ],\n  "groups": [{ "key": "newsroom", "name": "Newsroom", "members": ["ada", "max"] }],\n  "warnings": ["Max: the routine \\"New mention\\" starts on a Slack message and was not exported."]\n}\n```\n';

// src/export-skill.ts
var EXPORT_SKILL_FILE = "SKILL.md";
var EXPORT_SKILL = SKILL_default;

// src/staging.ts
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir as readdir3, rm as rm2 } from "node:fs/promises";
import { basename, dirname, join as join6 } from "node:path";

// src/readers/upload.ts
import { mkdtemp, open as open4, rm } from "node:fs/promises";
import { join as join5 } from "node:path";
async function stageUpload(source, options) {
  const maxBytes = Math.min(options.maxBytes ?? ZIP_UPLOAD_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES);
  if (options.declaredBytes !== void 0 && options.declaredBytes > maxBytes) {
    throw new ReaderError("too-large", `the archive is larger than ${maxBytes} bytes`);
  }
  const folder = await mkdtemp(join5(options.dir, "agent-import-"));
  const dispose = () => rm(folder, { recursive: true, force: true });
  const path = join5(folder, "source.zip");
  let size = 0;
  try {
    const handle = await open4(path, "wx", 384);
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) throw new ReaderError("too-large", `the archive is larger than ${maxBytes} bytes`);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
  } catch (err2) {
    await dispose();
    throw err2;
  }
  return { path, size, dispose };
}

// src/staging.ts
var MiB2 = 1024 * 1024;
var STAGE_MAX_BYTES = ZIP_UPLOAD_MAX_BYTES;
var STAGE_TTL_MS = 60 * 60 * 1e3;
var STAGES_PER_ACCOUNT = 5;
var KEY_PREFIX = "stage:";
var STAGING_DIR = "staging";
var ARCHIVE_FILE = "source.zip";
var FOLDER_RE = /^agent-import-[A-Za-z0-9]{6}$/;
var TOKEN_BYTES = 32;
var RecordSchema = strictObject({
  owner: string2().check(_minLength(1)),
  folder: string2().check(_regex(FOLDER_RE)),
  sha256: string2().check(_regex(/^[a-f0-9]{64}$/)),
  size: int().check(_nonnegative()),
  createdAt: number2(),
  expiresAt: number2()
});
var StageError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "StageError";
  }
  code;
};
function tokenDigest(token) {
  return createHash3("sha256").update(token).digest("hex");
}
function startsLikeZip(head) {
  return head[0] === 80 && head[1] === 75 && (head[2] === 3 && head[3] === 4 || head[2] === 5 && head[3] === 6);
}
async function readDigest(path) {
  const hash = createHash3("sha256");
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(path)) {
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      hash.update(chunk);
    }
  } catch {
    return null;
  }
  return { sha256: hash.digest("hex"), head };
}
async function fileSha256(path) {
  return (await readDigest(path))?.sha256 ?? null;
}
function createStaging(storage, now = Date.now) {
  const root = () => join6(storage.dir, STAGING_DIR);
  const archivePath = (folder) => join6(root(), folder, ARCHIVE_FILE);
  const busy = /* @__PURE__ */ new Set();
  const uploading = /* @__PURE__ */ new Map();
  const removeFolder = (folder) => rm2(join6(root(), folder), { recursive: true, force: true });
  async function records() {
    const out = [];
    for (const { key, value } of await storage.kv.list(KEY_PREFIX)) {
      const parsed = RecordSchema.safeParse(value);
      const digest2 = key.slice(KEY_PREFIX.length);
      if (parsed.success) out.push({ digest: digest2, record: parsed.data });
      else await storage.kv.del(key);
    }
    return out;
  }
  async function drop(digest2, record2) {
    await storage.kv.del(KEY_PREFIX + digest2);
    await removeFolder(record2.folder);
  }
  async function sweepExpired() {
    const at = now();
    for (const { digest: digest2, record: record2 } of await records()) {
      if (record2.expiresAt <= at && !busy.has(digest2)) await drop(digest2, record2);
    }
  }
  async function sweep() {
    await sweepExpired();
    const kept = new Set((await records()).map(({ record: record2 }) => record2.folder));
    let entries;
    try {
      entries = await readdir3(root());
    } catch {
      return;
    }
    for (const name2 of entries) {
      if (uploading.size > 0) return;
      if (!kept.has(name2)) await rm2(join6(root(), name2), { recursive: true, force: true });
    }
  }
  async function stage(owner, body) {
    await sweepExpired();
    const held = (await records()).filter(({ record: record2 }) => record2.owner === owner).length;
    const inFlight = uploading.get(owner) ?? 0;
    if (held + inFlight >= STAGES_PER_ACCOUNT) {
      throw new StageError("too_many", `At most ${STAGES_PER_ACCOUNT} imports may wait at once: finish or discard one first.`);
    }
    uploading.set(owner, inFlight + 1);
    try {
      await mkdir(root(), { recursive: true, mode: 448 });
      let upload;
      try {
        upload = await stageUpload(body, { dir: root(), maxBytes: STAGE_MAX_BYTES });
      } catch (err2) {
        if (err2 instanceof ReaderError && err2.code === "too-large") {
          throw new StageError("too_large", `The archive is larger than ${STAGE_MAX_BYTES / MiB2} MiB.`);
        }
        throw err2;
      }
      try {
        const folder = basename(dirname(upload.path));
        const read = await readDigest(upload.path);
        if (upload.size === 0) throw new StageError("empty", "The archive is empty.");
        if (!read || !startsLikeZip(read.head) || !FOLDER_RE.test(folder) || basename(upload.path) !== ARCHIVE_FILE) {
          throw new StageError("not_a_zip", "The file is not a zip archive.");
        }
        const token = randomBytes2(TOKEN_BYTES).toString("base64url");
        const createdAt = now();
        const record2 = { owner, folder, sha256: read.sha256, size: upload.size, createdAt, expiresAt: createdAt + STAGE_TTL_MS };
        await storage.kv.set(KEY_PREFIX + tokenDigest(token), record2);
        return { token, sha256: record2.sha256, size: record2.size, expiresAt: record2.expiresAt };
      } catch (err2) {
        await upload.dispose();
        throw err2;
      }
    } finally {
      const left = (uploading.get(owner) ?? 1) - 1;
      if (left > 0) uploading.set(owner, left);
      else uploading.delete(owner);
    }
  }
  const notFound = () => new StageError("not_found", "No pending import matches this token: it was used, discarded or has expired.");
  async function lookup(owner, token) {
    const digest2 = tokenDigest(token);
    const parsed = RecordSchema.safeParse(await storage.kv.get(KEY_PREFIX + digest2));
    if (!parsed.success || parsed.data.owner !== owner || busy.has(digest2)) throw notFound();
    if (parsed.data.expiresAt <= now()) {
      await drop(digest2, parsed.data);
      throw notFound();
    }
    return { digest: digest2, record: parsed.data };
  }
  const describe2 = (record2) => ({ sha256: record2.sha256, size: record2.size, expiresAt: record2.expiresAt });
  const changed = () => new StageError("archive_changed", "The staged archive changed on disk since it was received: stage it again.");
  async function inspect(owner, token) {
    const { digest: digest2, record: record2 } = await lookup(owner, token);
    const path = archivePath(record2.folder);
    if (await fileSha256(path) !== record2.sha256) {
      if (!busy.has(digest2)) await drop(digest2, record2);
      throw changed();
    }
    return { ...describe2(record2), path };
  }
  async function claim2(owner, token) {
    const { digest: digest2, record: record2 } = await lookup(owner, token);
    if (busy.has(digest2)) throw notFound();
    busy.add(digest2);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await removeFolder(record2.folder);
      } finally {
        busy.delete(digest2);
      }
    };
    try {
      await storage.kv.del(KEY_PREFIX + digest2);
      const path = archivePath(record2.folder);
      if (await fileSha256(path) !== record2.sha256) throw changed();
      return { ...describe2(record2), path, release };
    } catch (err2) {
      await release();
      throw err2;
    }
  }
  async function discard(owner, token) {
    const { digest: digest2, record: record2 } = await lookup(owner, token);
    if (busy.has(digest2)) throw notFound();
    busy.add(digest2);
    try {
      await drop(digest2, record2);
    } finally {
      busy.delete(digest2);
    }
  }
  return { stage, inspect, claim: claim2, discard, sweep };
}

// src/routes.ts
var TokenSchema = string2().check(_regex(/^[A-Za-z0-9_-]{43}$/));
var TokenBodySchema = strictObject({ token: TokenSchema });
var ElementsSchema = strictObject(Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, optional(boolean2())])));
var AgentChoiceSchema = strictObject({
  sourceRef: string2().check(_minLength(1), _maxLength(300)),
  include: optional(boolean2()),
  name: optional(string2().check(_minLength(1), _maxLength(100))),
  role: optional(string2().check(_minLength(1), _maxLength(32))),
  project: optional(nullable(string2().check(_minLength(1), _maxLength(200)))),
  cwd: optional(nullable(string2().check(_minLength(1), _maxLength(4096)))),
  elements: optional(ElementsSchema),
  keepRoutinesActive: optional(boolean2())
});
var OptionsSchema = strictObject({
  source: optional(string2().check(_minLength(1), _maxLength(64))),
  prefix: optional(string2().check(_regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/))),
  agents: optional(array(AgentChoiceSchema).check(_maxLength(100)))
});
var ImportRequestSchema = strictObject({ token: TokenSchema, options: optional(OptionsSchema) });
var HermesStageSchema = strictObject({
  profiles: optional(array(string2().check(_regex(HERMES_PROFILE_RE))).check(_minLength(1), _maxLength(100)))
});
var ExportBodySchema = union([
  strictObject({ agents: array(string2().check(_minLength(1), _maxLength(100))).check(_minLength(1), _maxLength(EXPORT_MAX_AGENTS)) }),
  strictObject({ all: literal(true) })
]);
var ZIP_TYPES = /* @__PURE__ */ new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);
var StageHeadersSchema = object({
  contentType: string2().check(refine((v) => ZIP_TYPES.has(v.split(";")[0].trim().toLowerCase()))),
  contentLength: optional(string2().check(_regex(/^\d{1,15}$/)))
});
var STATUS = {
  unauthorized: 401,
  forbidden: 403,
  invalid: 400,
  unsupported_media_type: 415,
  not_a_zip: 400,
  empty: 400,
  too_large: 413,
  too_many: 429,
  not_found: 404,
  archive_changed: 409,
  invalid_manifest: 422,
  not_implemented: 501,
  internal: 500
};
var RouteError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RouteError";
  }
  code;
};
function fail(res, code, message) {
  const body = { error: message, code };
  res.status(STATUS[code]).json(body);
}
function mountRoutes(ctx, staging, engine) {
  const router = ctx.router();
  const caller = () => {
    const user = ctx.user();
    if (!user) throw new RouteError("unauthorized", "Sign in to import agents.");
    try {
      ctx.assertPermission("agents:manage");
    } catch {
      throw new RouteError("forbidden", "Your account is not allowed to create agents.");
    }
    return user.id;
  };
  const reader = () => {
    const user = ctx.user();
    if (!user) throw new RouteError("unauthorized", "Sign in to export agents.");
    const holds = (permission) => {
      try {
        ctx.assertPermission(permission);
        return true;
      } catch {
        return false;
      }
    };
    if (!holds("agents:read") && !holds("agents:manage")) {
      throw new RouteError("forbidden", "Your account is not allowed to read agents.");
    }
    return user.id;
  };
  const tokenOf = (body) => {
    const parsed = TokenBodySchema.safeParse(body);
    if (!parsed.success) throw new RouteError("invalid", 'Expected a JSON body { "token": "\u2026" } with a staging token.');
    return parsed.data.token;
  };
  const requestOf = (body) => {
    const parsed = ImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new RouteError("invalid", 'Expected a JSON body { "token": "\u2026", "options": { \u2026 } } with a staging token.');
    }
    return { token: parsed.data.token, options: parsed.data.options ?? {} };
  };
  const answerError = (res, route, err2) => {
    if (err2 instanceof RouteError || err2 instanceof StageError) {
      fail(res, err2.code, err2.message);
      return;
    }
    if (err2 instanceof ExportError) {
      fail(res, err2.code, err2.message);
      return;
    }
    const name2 = err2 instanceof Error ? err2.name : "";
    if (name2 === "PluginCallerError") {
      fail(res, "forbidden", "Your account is not allowed to do this.");
      return;
    }
    if (err2?.code === "not_found") {
      fail(res, "not_found", "An agent of the export no longer exists.");
      return;
    }
    if (err2 instanceof ManifestError) {
      fail(res, "invalid_manifest", err2.message);
      return;
    }
    if (err2 instanceof ReaderError) {
      if (err2.code === "too-large" || err2.code === "too-many-files" || err2.code === "too-deep") {
        fail(res, "too_large", `The Hermes folder is too large to import: ${err2.message}.`);
        return;
      }
      if (err2.code === "changed") {
        fail(res, "archive_changed", "Hermes files changed while they were read: try again.");
        return;
      }
    }
    ctx.log.error(`${route} failed:`, err2 instanceof Error ? err2.message : "unknown error");
    fail(res, "internal", "The import failed on the daemon side.");
  };
  router.post("/stage", (req, res) => {
    (async () => {
      const owner = caller();
      const headers = StageHeadersSchema.safeParse({
        contentType: req.headers["content-type"] ?? "",
        contentLength: req.headers["content-length"]
      });
      if (!headers.success) {
        throw new RouteError("unsupported_media_type", "Send the archive itself as the body, with Content-Type: application/zip.");
      }
      if (Number(headers.data.contentLength ?? 0) > STAGE_MAX_BYTES) {
        throw new StageError("too_large", `The archive is larger than ${STAGE_MAX_BYTES / (1024 * 1024)} MiB.`);
      }
      const staged = await staging.stage(owner, req);
      res.status(201).json(staged);
    })().catch((err2) => answerError(res, "stage", err2));
  });
  router.post("/preview", (req, res) => {
    (async () => {
      const owner = caller();
      const { token, options } = requestOf(req.body);
      const { sha256, size, expiresAt, path } = await staging.inspect(owner, token);
      const manifest = await readManifestFromZip(path);
      const preview = await engine.preview(manifest, options);
      const body = { archive: { sha256, size, expiresAt }, preview, ready: true };
      res.json(body);
    })().catch((err2) => answerError(res, "preview", err2));
  });
  router.post("/apply", (req, res) => {
    (async () => {
      const owner = caller();
      const { token, options } = requestOf(req.body);
      const archive = await staging.claim(owner, token);
      let manifest;
      try {
        manifest = await readManifestFromZip(archive.path);
      } finally {
        await archive.release();
      }
      res.json(await engine.apply(manifest, options));
    })().catch((err2) => answerError(res, "apply", err2));
  });
  router.get("/agents", (_req, res) => {
    (async () => {
      reader();
      const agents = (await ctx.agents.list()).map((a) => ({ name: a.name, role: a.role, project: a.project }));
      res.json({ agents });
    })().catch((err2) => answerError(res, "agents", err2));
  });
  router.post("/export", (req, res) => {
    (async () => {
      reader();
      const parsed = ExportBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouteError("invalid", 'Expected a JSON body { "agents": ["name", \u2026] } or { "all": true }.');
      }
      const exportCtx = ctx;
      const { archive, fileName, manifest } = await buildExport(exportCtx, parsed.data);
      res.status(200);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("X-Timon-Agents", String(manifest.agents.length));
      res.setHeader("Cache-Control", "no-store");
      res.end(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
    })().catch((err2) => answerError(res, "export", err2));
  });
  router.get("/export-skill", (_req, res) => {
    (async () => {
      caller();
      res.status(200);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${EXPORT_SKILL_FILE}"`);
      res.setHeader("Cache-Control", "no-store");
      res.end(EXPORT_SKILL);
    })().catch((err2) => answerError(res, "export-skill", err2));
  });
  router.post("/discard", (req, res) => {
    (async () => {
      const owner = caller();
      const token = tokenOf(req.body);
      await staging.discard(owner, token);
      res.json({ discarded: true });
    })().catch((err2) => answerError(res, "discard", err2));
  });
  router.get("/hermes", (_req, res) => {
    (async () => {
      caller();
      const found = await detectHermes();
      const body = found ? {
        found: true,
        label: found.label,
        profiles: found.profiles.map((p) => ({ name: p.name, displayName: p.name === HERMES_DEFAULT_PROFILE ? "Hermes" : p.name }))
      } : { found: false, profiles: [] };
      res.json(body);
    })().catch((err2) => answerError(res, "hermes", err2));
  });
  router.post("/hermes/stage", (req, res) => {
    (async () => {
      const owner = caller();
      const parsed = HermesStageSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new RouteError("invalid", 'Expected a JSON body { "profiles"?: ["default", \u2026] } naming Hermes profiles.');
      const installation = await detectHermes();
      if (!installation) throw new RouteError("not_found", "No Hermes installation was found on the machine the daemon runs on.");
      const names = parsed.data.profiles;
      if (names) {
        const known = new Set(installation.profiles.map((p) => p.name));
        const unknown = names.filter((n) => !known.has(n));
        if (unknown.length > 0) throw new RouteError("not_found", `No Hermes profile named ${unknown.slice(0, 5).join(", ")} was found.`);
      }
      const manifest = await readHermesManifest(installation, names);
      const zip = zipSync({ [MANIFEST_FILE]: new TextEncoder().encode(JSON.stringify(manifest)) });
      const staged = await staging.stage(owner, (async function* () {
        yield zip;
      })());
      res.status(201).json(staged);
    })().catch((err2) => answerError(res, "hermes/stage", err2));
  });
}

// src/index.ts
var name = "agent-import";
function apply(ctx) {
  registerAppliedEvent(ctx);
  const staging = createStaging(ctx.storage);
  mountRoutes(ctx, staging, createEngine(ctx));
  staging.sweep().catch((err2) => {
    ctx.log.warn("staging sweep failed:", err2 instanceof Error ? err2.message : "unknown error");
  });
}
export {
  APPLIED_EVENT_NAME,
  APPLIED_EVENT_VERSION,
  AgentImportManifestSchema,
  AgentSchema,
  AvatarSchema,
  BUILTIN_SOURCES,
  DEFAULT_IMPORT_ROLE,
  DOC_NAME_RE,
  DocSchema,
  ENV_FILE_MAX_BYTES,
  ENV_NAMES_MAX,
  EXPORT_MAX_AGENTS,
  EXPORT_SOURCE_APP,
  ExportError,
  GroupSchema,
  HERMES_PROFILE_RE,
  HERMES_SOURCE_APP,
  HERMES_WANTS,
  HintsSchema,
  IMPORT_ELEMENTS,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  MANIFEST_MAX_BYTES,
  MANIFEST_VERSION,
  MEMORY_RULES_PER_AGENT,
  ManifestError,
  McpServerSchema,
  MemorySchema,
  OPENBOT_FORMAT,
  OPENBOT_MANIFEST_FILE,
  OPENBOT_SOURCE_ID,
  OPENBOT_VERSION,
  OPENBOT_WANTS,
  ROUTINE_PROMPT_MAX,
  RoutineSchema,
  SKILL_ID_RE,
  SOURCE_KEY_RE,
  SOURCE_SLOT,
  STAGES_PER_ACCOUNT,
  STAGE_MAX_BYTES,
  STAGE_TTL_MS,
  ScheduleSchema,
  SkillSchema,
  appliedEventId,
  apply,
  applyPlan,
  buildExport,
  createEngine,
  createRecords,
  decodeSchedule,
  detectHermes,
  hermesRootCandidate,
  hermesSchedule,
  hermesToManifest,
  isSafeRelativePath,
  keyOf2 as keyOf,
  manifestFromSource,
  memoryEntries,
  name,
  openbotSource,
  openbotToManifest,
  parseEnvNames,
  parseManifest,
  parseManifestText,
  planImport,
  publishApplied,
  readDirSource,
  readEnvNames,
  readHermesManifest,
  readHermesProfile,
  readManifestFromZip,
  redactArgs,
  sanitizeUrl,
  skippedWarnings,
  soulText,
  stripAllowedTools,
  suggestCwd
};
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 5.4.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
