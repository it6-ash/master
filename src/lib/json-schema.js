/**
 * Minimal JSON Schema (2020-12 subset) validator. Zero dependencies.
 *
 * Supports exactly the keywords used by schema/*.json:
 *   $ref (local #/... and cross-file "file.schema.json#/..."), $defs,
 *   type, enum, const,
 *   properties, required, additionalProperties, patternProperties, propertyNames,
 *   items, minItems, maxItems, uniqueItems,
 *   minLength, maxLength, pattern, format (date, date-time, ipv4),
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf,
 *   allOf, anyOf, oneOf, not,
 *   boolean schemas (true / false).
 *
 * Deliberately not ajv: the brief caps build-time dependencies, and this
 * subset is small enough to own outright.
 */

const MAX_DEPTH = 64;

/* ------------------------------------------------------------------ types */

function matchesType(value, t) {
  switch (t) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return false;
  }
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/* ---------------------------------------------------------------- formats */

function isDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime())
    && d.getUTCFullYear() === Number(m[1])
    && d.getUTCMonth() + 1 === Number(m[2])
    && d.getUTCDate() === Number(m[3]);
}

function isDateTime(v) {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/.test(v)) return false;
  return !Number.isNaN(new Date(v.replace(' ', 'T')).getTime());
}

function isIpv4(v) {
  const parts = String(v).split('.');
  return parts.length === 4
    && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

const FORMATS = {
  date: isDate,
  'date-time': isDateTime,
  ipv4: isIpv4,
};

/* ----------------------------------------------------------------- $ref */

function pointerEscape(token) {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function resolvePointer(root, pointer) {
  if (pointer === '' || pointer === '#') return root;
  const path = pointer.replace(/^#/, '');
  if (!path.startsWith('/')) return undefined;
  let cur = root;
  for (const rawToken of path.slice(1).split('/')) {
    const token = decodeURIComponent(rawToken).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[token];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/* ------------------------------------------------------------- registry */

export class SchemaRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.schemas = new Map();
  }

  add(schema, id = schema?.$id) {
    if (!id) throw new Error('SchemaRegistry.add: schema has no $id and no id was given');
    this.schemas.set(id, schema);
    return this;
  }

  get(id) {
    return this.schemas.get(id);
  }

  /**
   * @returns {Array<{path: string, message: string, schemaPath: string}>}
   */
  validate(schemaOrId, data) {
    const schema = typeof schemaOrId === 'string' ? this.get(schemaOrId) : schemaOrId;
    if (!schema) {
      return [{ path: '', message: `no schema registered as "${schemaOrId}"`, schemaPath: '' }];
    }
    const errors = [];
    walk(schema, data, { registry: this, root: schema, errors, depth: 0 }, '', '#');
    return errors;
  }
}

/* --------------------------------------------------------------- walker */

function err(ctx, path, schemaPath, message) {
  ctx.errors.push({ path: path || '/', message, schemaPath });
}

function walk(schema, value, ctx, path, schemaPath) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    err(ctx, path, schemaPath, 'schema is false: no value is valid here');
    return;
  }
  if (ctx.depth > MAX_DEPTH) {
    err(ctx, path, schemaPath, 'maximum schema depth exceeded (circular $ref?)');
    return;
  }

  // ---- $ref ------------------------------------------------------------
  if (typeof schema.$ref === 'string') {
    const [file, pointer = ''] = schema.$ref.split('#');
    let refRoot = ctx.root;
    if (file) {
      refRoot = ctx.registry.get(file);
      if (!refRoot) {
        err(ctx, path, schemaPath, `unresolvable $ref "${schema.$ref}" (no schema with $id "${file}")`);
        return;
      }
    }
    const target = resolvePointer(refRoot, pointer ? `#${pointer}` : '#');
    if (target === undefined) {
      err(ctx, path, schemaPath, `unresolvable $ref "${schema.$ref}"`);
      return;
    }
    walk(target, value, { ...ctx, root: refRoot, depth: ctx.depth + 1 }, path, `${schemaPath}/$ref`);
    // A $ref sibling to other keywords is legal in 2020-12; keep going.
  }

  // ---- type ------------------------------------------------------------
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      err(ctx, path, `${schemaPath}/type`, `expected ${types.join(' or ')}, got ${typeName(value)}`);
      return; // further keywords would only produce noise
    }
  }

  // ---- const / enum ----------------------------------------------------
  if ('const' in schema && !deepEqual(value, schema.const)) {
    err(ctx, path, `${schemaPath}/const`, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((c) => deepEqual(value, c))) {
    err(ctx, path, `${schemaPath}/enum`, `${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  // ---- combinators -----------------------------------------------------
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((sub, i) => walk(sub, value, { ...ctx, depth: ctx.depth + 1 }, path, `${schemaPath}/allOf/${i}`));
  }
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((sub, i) => collect(sub, value, ctx, path, `${schemaPath}/anyOf/${i}`));
    if (branchErrors.every((e) => e.length > 0)) {
      err(ctx, path, `${schemaPath}/anyOf`, `matched none of the ${schema.anyOf.length} allowed shapes`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((sub, i) => collect(sub, value, ctx, path, `${schemaPath}/oneOf/${i}`).length === 0);
    if (passing.length !== 1) {
      err(ctx, path, `${schemaPath}/oneOf`, `must match exactly one shape, matched ${passing.length}`);
    }
  }
  if (schema.not !== undefined && collect(schema.not, value, ctx, path, `${schemaPath}/not`).length === 0) {
    err(ctx, path, `${schemaPath}/not`, 'must NOT match the "not" schema');
  }

  // ---- strings ---------------------------------------------------------
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      err(ctx, path, `${schemaPath}/minLength`, `shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      err(ctx, path, `${schemaPath}/maxLength`, `longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      err(ctx, path, `${schemaPath}/pattern`, `${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
    if (typeof schema.format === 'string' && FORMATS[schema.format] && !FORMATS[schema.format](value)) {
      err(ctx, path, `${schemaPath}/format`, `${JSON.stringify(value)} is not a valid ${schema.format}`);
    }
  }

  // ---- numbers ---------------------------------------------------------
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      err(ctx, path, `${schemaPath}/minimum`, `${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      err(ctx, path, `${schemaPath}/maximum`, `${value} > maximum ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      err(ctx, path, `${schemaPath}/exclusiveMinimum`, `${value} must be > ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      err(ctx, path, `${schemaPath}/exclusiveMaximum`, `${value} must be < ${schema.exclusiveMaximum}`);
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const q = value / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) {
        err(ctx, path, `${schemaPath}/multipleOf`, `${value} is not a multiple of ${schema.multipleOf}`);
      }
    }
  }

  // ---- arrays ----------------------------------------------------------
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      err(ctx, path, `${schemaPath}/minItems`, `${value.length} items, minimum ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      err(ctx, path, `${schemaPath}/maxItems`, `${value.length} items, maximum ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          err(ctx, path, `${schemaPath}/uniqueItems`, `duplicate item ${key}`);
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => {
        walk(schema.items, item, { ...ctx, depth: ctx.depth + 1 }, `${path}/${i}`, `${schemaPath}/items`);
      });
    }
  }

  // ---- objects ---------------------------------------------------------
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);

    for (const req of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) {
        err(ctx, path, `${schemaPath}/required`, `missing required property "${req}"`);
      }
    }

    if (schema.propertyNames !== undefined) {
      for (const key of keys) {
        const sub = collect(schema.propertyNames, key, ctx, `${path}/${pointerEscape(key)}`, `${schemaPath}/propertyNames`);
        if (sub.length) {
          err(ctx, path, `${schemaPath}/propertyNames`, `key ${JSON.stringify(key)} is not a valid property name: ${sub[0].message}`);
        }
      }
    }

    const matchedByPattern = new Set();
    if (schema.patternProperties) {
      for (const [pattern, sub] of Object.entries(schema.patternProperties)) {
        const re = new RegExp(pattern, 'u');
        for (const key of keys) {
          if (!re.test(key)) continue;
          matchedByPattern.add(key);
          walk(sub, value[key], { ...ctx, depth: ctx.depth + 1 }, `${path}/${pointerEscape(key)}`, `${schemaPath}/patternProperties/${pattern}`);
        }
      }
    }

    const declared = schema.properties ?? {};
    for (const [key, sub] of Object.entries(declared)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      walk(sub, value[key], { ...ctx, depth: ctx.depth + 1 }, `${path}/${pointerEscape(key)}`, `${schemaPath}/properties/${key}`);
    }

    if (schema.additionalProperties !== undefined) {
      for (const key of keys) {
        if (key in declared || matchedByPattern.has(key)) continue;
        if (schema.additionalProperties === false) {
          err(ctx, `${path}/${pointerEscape(key)}`, `${schemaPath}/additionalProperties`, `unknown property "${key}"`);
        } else {
          walk(schema.additionalProperties, value[key], { ...ctx, depth: ctx.depth + 1 }, `${path}/${pointerEscape(key)}`, `${schemaPath}/additionalProperties`);
        }
      }
    }
  }
}

/** Run a subschema into a throwaway error list (for anyOf/oneOf/not). */
function collect(schema, value, ctx, path, schemaPath) {
  const errors = [];
  walk(schema, value, { ...ctx, errors, depth: ctx.depth + 1 }, path, schemaPath);
  return errors;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
