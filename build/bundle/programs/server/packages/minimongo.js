(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var ECMAScript = Package.ecmascript.ECMAScript;
var EJSON = Package.ejson.EJSON;
var GeoJSON = Package['geojson-utils'].GeoJSON;
var IdMap = Package['id-map'].IdMap;
var MongoID = Package['mongo-id'].MongoID;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var Random = Package.random.Random;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var Decimal = Package['mongo-decimal'].Decimal;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var operand, selectorValue, MinimongoTest, MinimongoError, selector, doc, callback, options, oldResults, a, b, LocalCollection, Minimongo;

var require = meteorInstall({"node_modules":{"meteor":{"minimongo":{"minimongo_server.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_server.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.link("./minimongo_common.js");
let hasOwn, isNumericKey, isOperatorObject, pathsToTree, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },
  isNumericKey(v) {
    isNumericKey = v;
  },
  isOperatorObject(v) {
    isOperatorObject = v;
  },
  pathsToTree(v) {
    pathsToTree = v;
  },
  projectionDetails(v) {
    projectionDetails = v;
  }
}, 0);
Minimongo._pathsElidingNumericKeys = paths => paths.map(path => path.split('.').filter(part => !isNumericKey(part)).join('.'));

// Returns true if the modifier applied to some document may change the result
// of matching the document by selector
// The modifier is always in a form of Object:
//  - $set
//    - 'a.b.22.z': value
//    - 'foo.bar': 42
//  - $unset
//    - 'abc.d': 1
Minimongo.Matcher.prototype.affectedByModifier = function (modifier) {
  // safe check for $set/$unset being objects
  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);
  const meaningfulPaths = this._getPaths();
  const modifiedPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));
  return modifiedPaths.some(path => {
    const mod = path.split('.');
    return meaningfulPaths.some(meaningfulPath => {
      const sel = meaningfulPath.split('.');
      let i = 0,
        j = 0;
      while (i < sel.length && j < mod.length) {
        if (isNumericKey(sel[i]) && isNumericKey(mod[j])) {
          // foo.4.bar selector affected by foo.4 modifier
          // foo.3.bar selector unaffected by foo.4 modifier
          if (sel[i] === mod[j]) {
            i++;
            j++;
          } else {
            return false;
          }
        } else if (isNumericKey(sel[i])) {
          // foo.4.bar selector unaffected by foo.bar modifier
          return false;
        } else if (isNumericKey(mod[j])) {
          j++;
        } else if (sel[i] === mod[j]) {
          i++;
          j++;
        } else {
          return false;
        }
      }

      // One is a prefix of another, taking numeric fields into account
      return true;
    });
  });
};

// @param modifier - Object: MongoDB-styled modifier with `$set`s and `$unsets`
//                           only. (assumed to come from oplog)
// @returns - Boolean: if after applying the modifier, selector can start
//                     accepting the modified value.
// NOTE: assumes that document affected by modifier didn't match this Matcher
// before, so if modifier can't convince selector in a positive change it would
// stay 'false'.
// Currently doesn't support $-operators and numeric indices precisely.
Minimongo.Matcher.prototype.canBecomeTrueByModifier = function (modifier) {
  if (!this.affectedByModifier(modifier)) {
    return false;
  }
  if (!this.isSimple()) {
    return true;
  }
  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);
  const modifierPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));
  if (this._getPaths().some(pathHasNumericKeys) || modifierPaths.some(pathHasNumericKeys)) {
    return true;
  }

  // check if there is a $set or $unset that indicates something is an
  // object rather than a scalar in the actual object where we saw $-operator
  // NOTE: it is correct since we allow only scalars in $-operators
  // Example: for selector {'a.b': {$gt: 5}} the modifier {'a.b.c':7} would
  // definitely set the result to false as 'a.b' appears to be an object.
  const expectedScalarIsObject = Object.keys(this._selector).some(path => {
    if (!isOperatorObject(this._selector[path])) {
      return false;
    }
    return modifierPaths.some(modifierPath => modifierPath.startsWith("".concat(path, ".")));
  });
  if (expectedScalarIsObject) {
    return false;
  }

  // See if we can apply the modifier on the ideally matching object. If it
  // still matches the selector, then the modifier could have turned the real
  // object in the database into something matching.
  const matchingDocument = EJSON.clone(this.matchingDocument());

  // The selector is too complex, anything can happen.
  if (matchingDocument === null) {
    return true;
  }
  try {
    LocalCollection._modify(matchingDocument, modifier);
  } catch (error) {
    // Couldn't set a property on a field which is a scalar or null in the
    // selector.
    // Example:
    // real document: { 'a.b': 3 }
    // selector: { 'a': 12 }
    // converted selector (ideal document): { 'a': 12 }
    // modifier: { $set: { 'a.b': 4 } }
    // We don't know what real document was like but from the error raised by
    // $set on a scalar field we can reason that the structure of real document
    // is completely different.
    if (error.name === 'MinimongoError' && error.setPropertyError) {
      return false;
    }
    throw error;
  }
  return this.documentMatches(matchingDocument).result;
};

// Knows how to combine a mongo selector and a fields projection to a new fields
// projection taking into account active fields from the passed selector.
// @returns Object - projection object (same as fields option of mongo cursor)
Minimongo.Matcher.prototype.combineIntoProjection = function (projection) {
  const selectorPaths = Minimongo._pathsElidingNumericKeys(this._getPaths());

  // Special case for $where operator in the selector - projection should depend
  // on all fields of the document. getSelectorPaths returns a list of paths
  // selector depends on. If one of the paths is '' (empty string) representing
  // the root or the whole document, complete projection should be returned.
  if (selectorPaths.includes('')) {
    return {};
  }
  return combineImportantPathsIntoProjection(selectorPaths, projection);
};

// Returns an object that would match the selector if possible or null if the
// selector is too complex for us to analyze
// { 'a.b': { ans: 42 }, 'foo.bar': null, 'foo.baz': "something" }
// => { a: { b: { ans: 42 } }, foo: { bar: null, baz: "something" } }
Minimongo.Matcher.prototype.matchingDocument = function () {
  // check if it was computed before
  if (this._matchingDocument !== undefined) {
    return this._matchingDocument;
  }

  // If the analysis of this selector is too hard for our implementation
  // fallback to "YES"
  let fallback = false;
  this._matchingDocument = pathsToTree(this._getPaths(), path => {
    const valueSelector = this._selector[path];
    if (isOperatorObject(valueSelector)) {
      // if there is a strict equality, there is a good
      // chance we can use one of those as "matching"
      // dummy value
      if (valueSelector.$eq) {
        return valueSelector.$eq;
      }
      if (valueSelector.$in) {
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        });

        // Return anything from $in that matches the whole selector for this
        // path. If nothing matches, returns `undefined` as nothing can make
        // this selector into `true`.
        return valueSelector.$in.find(placeholder => matcher.documentMatches({
          placeholder
        }).result);
      }
      if (onlyContainsKeys(valueSelector, ['$gt', '$gte', '$lt', '$lte'])) {
        let lowerBound = -Infinity;
        let upperBound = Infinity;
        ['$lte', '$lt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] < upperBound) {
            upperBound = valueSelector[op];
          }
        });
        ['$gte', '$gt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] > lowerBound) {
            lowerBound = valueSelector[op];
          }
        });
        const middle = (lowerBound + upperBound) / 2;
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        });
        if (!matcher.documentMatches({
          placeholder: middle
        }).result && (middle === lowerBound || middle === upperBound)) {
          fallback = true;
        }
        return middle;
      }
      if (onlyContainsKeys(valueSelector, ['$nin', '$ne'])) {
        // Since this._isSimple makes sure $nin and $ne are not combined with
        // objects or arrays, we can confidently return an empty object as it
        // never matches any scalar.
        return {};
      }
      fallback = true;
    }
    return this._selector[path];
  }, x => x);
  if (fallback) {
    this._matchingDocument = null;
  }
  return this._matchingDocument;
};

// Minimongo.Sorter gets a similar method, which delegates to a Matcher it made
// for this exact purpose.
Minimongo.Sorter.prototype.affectedByModifier = function (modifier) {
  return this._selectorForAffectedByModifier.affectedByModifier(modifier);
};
Minimongo.Sorter.prototype.combineIntoProjection = function (projection) {
  return combineImportantPathsIntoProjection(Minimongo._pathsElidingNumericKeys(this._getPaths()), projection);
};
function combineImportantPathsIntoProjection(paths, projection) {
  const details = projectionDetails(projection);

  // merge the paths to include
  const tree = pathsToTree(paths, path => true, (node, path, fullPath) => true, details.tree);
  const mergedProjection = treeToPaths(tree);
  if (details.including) {
    // both selector and projection are pointing on fields to include
    // so we can just return the merged tree
    return mergedProjection;
  }

  // selector is pointing at fields to include
  // projection is pointing at fields to exclude
  // make sure we don't exclude important paths
  const mergedExclProjection = {};
  Object.keys(mergedProjection).forEach(path => {
    if (!mergedProjection[path]) {
      mergedExclProjection[path] = false;
    }
  });
  return mergedExclProjection;
}
function getPaths(selector) {
  return Object.keys(new Minimongo.Matcher(selector)._paths);

  // XXX remove it?
  // return Object.keys(selector).map(k => {
  //   // we don't know how to handle $where because it can be anything
  //   if (k === '$where') {
  //     return ''; // matches everything
  //   }

  //   // we branch from $or/$and/$nor operator
  //   if (['$or', '$and', '$nor'].includes(k)) {
  //     return selector[k].map(getPaths);
  //   }

  //   // the value is a literal or some comparison operator
  //   return k;
  // })
  //   .reduce((a, b) => a.concat(b), [])
  //   .filter((a, b, c) => c.indexOf(a) === b);
}

// A helper to ensure object has only certain keys
function onlyContainsKeys(obj, keys) {
  return Object.keys(obj).every(k => keys.includes(k));
}
function pathHasNumericKeys(path) {
  return path.split('.').some(isNumericKey);
}

// Returns a set of key paths similar to
// { 'foo.bar': 1, 'a.b.c': 1 }
function treeToPaths(tree) {
  let prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : '';
  const result = {};
  Object.keys(tree).forEach(key => {
    const value = tree[key];
    if (value === Object(value)) {
      Object.assign(result, treeToPaths(value, "".concat(prefix + key, ".")));
    } else {
      result[prefix + key] = value;
    }
  });
  return result;
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/common.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  hasOwn: () => hasOwn,
  ELEMENT_OPERATORS: () => ELEMENT_OPERATORS,
  compileDocumentSelector: () => compileDocumentSelector,
  equalityElementMatcher: () => equalityElementMatcher,
  expandArraysInBranches: () => expandArraysInBranches,
  isIndexable: () => isIndexable,
  isNumericKey: () => isNumericKey,
  isOperatorObject: () => isOperatorObject,
  makeLookupFunction: () => makeLookupFunction,
  nothingMatcher: () => nothingMatcher,
  pathsToTree: () => pathsToTree,
  populateDocumentWithQueryFields: () => populateDocumentWithQueryFields,
  projectionDetails: () => projectionDetails,
  regexpElementMatcher: () => regexpElementMatcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }
}, 0);
const hasOwn = Object.prototype.hasOwnProperty;
const ELEMENT_OPERATORS = {
  $lt: makeInequality(cmpValue => cmpValue < 0),
  $gt: makeInequality(cmpValue => cmpValue > 0),
  $lte: makeInequality(cmpValue => cmpValue <= 0),
  $gte: makeInequality(cmpValue => cmpValue >= 0),
  $mod: {
    compileElementSelector(operand) {
      if (!(Array.isArray(operand) && operand.length === 2 && typeof operand[0] === 'number' && typeof operand[1] === 'number')) {
        throw Error('argument to $mod must be an array of two numbers');
      }

      // XXX could require to be ints or round or something
      const divisor = operand[0];
      const remainder = operand[1];
      return value => typeof value === 'number' && value % divisor === remainder;
    }
  },
  $in: {
    compileElementSelector(operand) {
      if (!Array.isArray(operand)) {
        throw Error('$in needs an array');
      }
      const elementMatchers = operand.map(option => {
        if (option instanceof RegExp) {
          return regexpElementMatcher(option);
        }
        if (isOperatorObject(option)) {
          throw Error('cannot nest $ under $in');
        }
        return equalityElementMatcher(option);
      });
      return value => {
        // Allow {a: {$in: [null]}} to match when 'a' does not exist.
        if (value === undefined) {
          value = null;
        }
        return elementMatchers.some(matcher => matcher(value));
      };
    }
  },
  $size: {
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a
    // possible value.
    dontExpandLeafArrays: true,
    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        // Don't ask me why, but by experimentation, this seems to be what Mongo
        // does.
        operand = 0;
      } else if (typeof operand !== 'number') {
        throw Error('$size needs a number');
      }
      return value => Array.isArray(value) && value.length === operand;
    }
  },
  $type: {
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but
    // should *not* include it itself.
    dontIncludeLeafArrays: true,
    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        const operandAliasMap = {
          'double': 1,
          'string': 2,
          'object': 3,
          'array': 4,
          'binData': 5,
          'undefined': 6,
          'objectId': 7,
          'bool': 8,
          'date': 9,
          'null': 10,
          'regex': 11,
          'dbPointer': 12,
          'javascript': 13,
          'symbol': 14,
          'javascriptWithScope': 15,
          'int': 16,
          'timestamp': 17,
          'long': 18,
          'decimal': 19,
          'minKey': -1,
          'maxKey': 127
        };
        if (!hasOwn.call(operandAliasMap, operand)) {
          throw Error("unknown string alias for $type: ".concat(operand));
        }
        operand = operandAliasMap[operand];
      } else if (typeof operand === 'number') {
        if (operand === 0 || operand < -1 || operand > 19 && operand !== 127) {
          throw Error("Invalid numerical $type code: ".concat(operand));
        }
      } else {
        throw Error('argument to $type is not a number or a string');
      }
      return value => value !== undefined && LocalCollection._f._type(value) === operand;
    }
  },
  $bitsAllSet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllSet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => (bitmask[i] & byte) === byte);
      };
    }
  },
  $bitsAnySet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnySet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (~bitmask[i] & byte) !== byte);
      };
    }
  },
  $bitsAllClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => !(bitmask[i] & byte));
      };
    }
  },
  $bitsAnyClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnyClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (bitmask[i] & byte) !== byte);
      };
    }
  },
  $regex: {
    compileElementSelector(operand, valueSelector) {
      if (!(typeof operand === 'string' || operand instanceof RegExp)) {
        throw Error('$regex has to be a string or RegExp');
      }
      let regexp;
      if (valueSelector.$options !== undefined) {
        // Options passed in $options (even the empty string) always overrides
        // options in the RegExp object itself.

        // Be clear that we only support the JS-supported options, not extended
        // ones (eg, Mongo supports x and s). Ideally we would implement x and s
        // by transforming the regexp, but not today...
        if (/[^gim]/.test(valueSelector.$options)) {
          throw new Error('Only the i, m, and g regexp options are supported');
        }
        const source = operand instanceof RegExp ? operand.source : operand;
        regexp = new RegExp(source, valueSelector.$options);
      } else if (operand instanceof RegExp) {
        regexp = operand;
      } else {
        regexp = new RegExp(operand);
      }
      return regexpElementMatcher(regexp);
    }
  },
  $elemMatch: {
    dontExpandLeafArrays: true,
    compileElementSelector(operand, valueSelector, matcher) {
      if (!LocalCollection._isPlainObject(operand)) {
        throw Error('$elemMatch need an object');
      }
      const isDocMatcher = !isOperatorObject(Object.keys(operand).filter(key => !hasOwn.call(LOGICAL_OPERATORS, key)).reduce((a, b) => Object.assign(a, {
        [b]: operand[b]
      }), {}), true);
      let subMatcher;
      if (isDocMatcher) {
        // This is NOT the same as compileValueSelector(operand), and not just
        // because of the slightly different calling convention.
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.
        subMatcher = compileDocumentSelector(operand, matcher, {
          inElemMatch: true
        });
      } else {
        subMatcher = compileValueSelector(operand, matcher);
      }
      return value => {
        if (!Array.isArray(value)) {
          return false;
        }
        for (let i = 0; i < value.length; ++i) {
          const arrayElement = value[i];
          let arg;
          if (isDocMatcher) {
            // We can only match {$elemMatch: {b: 3}} against objects.
            // (We can also match against arrays, if there's numeric indices,
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)
            if (!isIndexable(arrayElement)) {
              return false;
            }
            arg = arrayElement;
          } else {
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches
            // {a: [8]} but not {a: [[8]]}
            arg = [{
              value: arrayElement,
              dontIterate: true
            }];
          }
          // XXX support $near in $elemMatch by propagating $distance?
          if (subMatcher(arg).result) {
            return i; // specially understood to mean "use as arrayIndices"
          }
        }

        return false;
      };
    }
  }
};
// Operators that appear at the top level of a document selector.
const LOGICAL_OPERATORS = {
  $and(subSelector, matcher, inElemMatch) {
    return andDocumentMatchers(compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch));
  },
  $or(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch);

    // Special case: if there is only one matcher, use it directly, *preserving*
    // any arrayIndices it returns.
    if (matchers.length === 1) {
      return matchers[0];
    }
    return doc => {
      const result = matchers.some(fn => fn(doc).result);
      // $or does NOT set arrayIndices when it has multiple
      // sub-expressions. (Tested against MongoDB.)
      return {
        result
      };
    };
  },
  $nor(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch);
    return doc => {
      const result = matchers.every(fn => !fn(doc).result);
      // Never set arrayIndices, because we only match if nothing in particular
      // 'matched' (and because this is consistent with MongoDB).
      return {
        result
      };
    };
  },
  $where(selectorValue, matcher) {
    // Record that *any* path may be used.
    matcher._recordPathUsed('');
    matcher._hasWhere = true;
    if (!(selectorValue instanceof Function)) {
      // XXX MongoDB seems to have more complex logic to decide where or or not
      // to add 'return'; not sure exactly what it is.
      selectorValue = Function('obj', "return ".concat(selectorValue));
    }

    // We make the document available as both `this` and `obj`.
    // // XXX not sure what we should do if this throws
    return doc => ({
      result: selectorValue.call(doc, doc)
    });
  },
  // This is just used as a comment in the query (in MongoDB, it also ends up in
  // query logs); it has no effect on the actual selection.
  $comment() {
    return () => ({
      result: true
    });
  }
};

// Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as
// "match each branched value independently and combine with
// convertElementMatcherToBranchedMatcher".
const VALUE_OPERATORS = {
  $eq(operand) {
    return convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand));
  },
  $not(operand, valueSelector, matcher) {
    return invertBranchedMatcher(compileValueSelector(operand, matcher));
  },
  $ne(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand)));
  },
  $nin(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(ELEMENT_OPERATORS.$in.compileElementSelector(operand)));
  },
  $exists(operand) {
    const exists = convertElementMatcherToBranchedMatcher(value => value !== undefined);
    return operand ? exists : invertBranchedMatcher(exists);
  },
  // $options just provides options for $regex; its logic is inside $regex
  $options(operand, valueSelector) {
    if (!hasOwn.call(valueSelector, '$regex')) {
      throw Error('$options needs a $regex');
    }
    return everythingMatcher;
  },
  // $maxDistance is basically an argument to $near
  $maxDistance(operand, valueSelector) {
    if (!valueSelector.$near) {
      throw Error('$maxDistance needs a $near');
    }
    return everythingMatcher;
  },
  $all(operand, valueSelector, matcher) {
    if (!Array.isArray(operand)) {
      throw Error('$all requires array');
    }

    // Not sure why, but this seems to be what MongoDB does.
    if (operand.length === 0) {
      return nothingMatcher;
    }
    const branchedMatchers = operand.map(criterion => {
      // XXX handle $all/$elemMatch combination
      if (isOperatorObject(criterion)) {
        throw Error('no $ expressions in $all');
      }

      // This is always a regexp or equality selector.
      return compileValueSelector(criterion, matcher);
    });

    // andBranchedMatchers does NOT require all selectors to return true on the
    // SAME branch.
    return andBranchedMatchers(branchedMatchers);
  },
  $near(operand, valueSelector, matcher, isRoot) {
    if (!isRoot) {
      throw Error('$near can\'t be inside another $ operator');
    }
    matcher._hasGeoQuery = true;

    // There are two kinds of geodata in MongoDB: legacy coordinate pairs and
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are
    // marked with a $geometry property, though legacy coordinates can be
    // matched using $geometry.
    let maxDistance, point, distance;
    if (LocalCollection._isPlainObject(operand) && hasOwn.call(operand, '$geometry')) {
      // GeoJSON "2dsphere" mode.
      maxDistance = operand.$maxDistance;
      point = operand.$geometry;
      distance = value => {
        // XXX: for now, we don't calculate the actual distance between, say,
        // polygon and circle. If people care about this use-case it will get
        // a priority.
        if (!value) {
          return null;
        }
        if (!value.type) {
          return GeoJSON.pointDistance(point, {
            type: 'Point',
            coordinates: pointToArray(value)
          });
        }
        if (value.type === 'Point') {
          return GeoJSON.pointDistance(point, value);
        }
        return GeoJSON.geometryWithinRadius(value, point, maxDistance) ? 0 : maxDistance + 1;
      };
    } else {
      maxDistance = valueSelector.$maxDistance;
      if (!isIndexable(operand)) {
        throw Error('$near argument must be coordinate pair or GeoJSON');
      }
      point = pointToArray(operand);
      distance = value => {
        if (!isIndexable(value)) {
          return null;
        }
        return distanceCoordinatePairs(point, value);
      };
    }
    return branchedValues => {
      // There might be multiple points in the document that match the given
      // field. Only one of them needs to be within $maxDistance, but we need to
      // evaluate all of them and use the nearest one for the implicit sort
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)
      //
      // Note: This differs from MongoDB's implementation, where a document will
      // actually show up *multiple times* in the result set, with one entry for
      // each within-$maxDistance branching point.
      const result = {
        result: false
      };
      expandArraysInBranches(branchedValues).every(branch => {
        // if operation is an update, don't skip branches, just return the first
        // one (#3599)
        let curDistance;
        if (!matcher._isUpdate) {
          if (!(typeof branch.value === 'object')) {
            return true;
          }
          curDistance = distance(branch.value);

          // Skip branches that aren't real points or are too far away.
          if (curDistance === null || curDistance > maxDistance) {
            return true;
          }

          // Skip anything that's a tie.
          if (result.distance !== undefined && result.distance <= curDistance) {
            return true;
          }
        }
        result.result = true;
        result.distance = curDistance;
        if (branch.arrayIndices) {
          result.arrayIndices = branch.arrayIndices;
        } else {
          delete result.arrayIndices;
        }
        return !matcher._isUpdate;
      });
      return result;
    };
  }
};

// NB: We are cheating and using this function to implement 'AND' for both
// 'document matchers' and 'branched matchers'. They both return result objects
// but the argument is different: for the former it's a whole doc, whereas for
// the latter it's an array of 'branched values'.
function andSomeMatchers(subMatchers) {
  if (subMatchers.length === 0) {
    return everythingMatcher;
  }
  if (subMatchers.length === 1) {
    return subMatchers[0];
  }
  return docOrBranches => {
    const match = {};
    match.result = subMatchers.every(fn => {
      const subResult = fn(docOrBranches);

      // Copy a 'distance' number out of the first sub-matcher that has
      // one. Yes, this means that if there are multiple $near fields in a
      // query, something arbitrary happens; this appears to be consistent with
      // Mongo.
      if (subResult.result && subResult.distance !== undefined && match.distance === undefined) {
        match.distance = subResult.distance;
      }

      // Similarly, propagate arrayIndices from sub-matchers... but to match
      // MongoDB behavior, this time the *last* sub-matcher with arrayIndices
      // wins.
      if (subResult.result && subResult.arrayIndices) {
        match.arrayIndices = subResult.arrayIndices;
      }
      return subResult.result;
    });

    // If we didn't actually match, forget any extra metadata we came up with.
    if (!match.result) {
      delete match.distance;
      delete match.arrayIndices;
    }
    return match;
  };
}
const andDocumentMatchers = andSomeMatchers;
const andBranchedMatchers = andSomeMatchers;
function compileArrayOfDocumentSelectors(selectors, matcher, inElemMatch) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw Error('$and/$or/$nor must be nonempty array');
  }
  return selectors.map(subSelector => {
    if (!LocalCollection._isPlainObject(subSelector)) {
      throw Error('$or/$and/$nor entries need to be full objects');
    }
    return compileDocumentSelector(subSelector, matcher, {
      inElemMatch
    });
  });
}

// Takes in a selector that could match a full document (eg, the original
// selector). Returns a function mapping document->result object.
//
// matcher is the Matcher object we are compiling.
//
// If this is the root document selector (ie, not wrapped in $and or the like),
// then isRoot is true. (This is used by $near.)
function compileDocumentSelector(docSelector, matcher) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  const docMatchers = Object.keys(docSelector).map(key => {
    const subSelector = docSelector[key];
    if (key.substr(0, 1) === '$') {
      // Outer operators are either logical operators (they recurse back into
      // this function), or $where.
      if (!hasOwn.call(LOGICAL_OPERATORS, key)) {
        throw new Error("Unrecognized logical operator: ".concat(key));
      }
      matcher._isSimple = false;
      return LOGICAL_OPERATORS[key](subSelector, matcher, options.inElemMatch);
    }

    // Record this path, but only if we aren't in an elemMatcher, since in an
    // elemMatch this is a path inside an object in an array, not in the doc
    // root.
    if (!options.inElemMatch) {
      matcher._recordPathUsed(key);
    }

    // Don't add a matcher if subSelector is a function -- this is to match
    // the behavior of Meteor on the server (inherited from the node mongodb
    // driver), which is to ignore any part of a selector which is a function.
    if (typeof subSelector === 'function') {
      return undefined;
    }
    const lookUpByIndex = makeLookupFunction(key);
    const valueMatcher = compileValueSelector(subSelector, matcher, options.isRoot);
    return doc => valueMatcher(lookUpByIndex(doc));
  }).filter(Boolean);
  return andDocumentMatchers(docMatchers);
}
// Takes in a selector that could match a key-indexed value in a document; eg,
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to
// indicate equality).  Returns a branched matcher: a function mapping
// [branched value]->result object.
function compileValueSelector(valueSelector, matcher, isRoot) {
  if (valueSelector instanceof RegExp) {
    matcher._isSimple = false;
    return convertElementMatcherToBranchedMatcher(regexpElementMatcher(valueSelector));
  }
  if (isOperatorObject(valueSelector)) {
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);
  }
  return convertElementMatcherToBranchedMatcher(equalityElementMatcher(valueSelector));
}

// Given an element matcher (which evaluates a single value), returns a branched
// value (which evaluates the element matcher on all the branches and returns a
// more structured return value possibly including arrayIndices).
function convertElementMatcherToBranchedMatcher(elementMatcher) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  return branches => {
    const expanded = options.dontExpandLeafArrays ? branches : expandArraysInBranches(branches, options.dontIncludeLeafArrays);
    const match = {};
    match.result = expanded.some(element => {
      let matched = elementMatcher(element.value);

      // Special case for $elemMatch: it means "true, and use this as an array
      // index if I didn't already have one".
      if (typeof matched === 'number') {
        // XXX This code dates from when we only stored a single array index
        // (for the outermost array). Should we be also including deeper array
        // indices from the $elemMatch match?
        if (!element.arrayIndices) {
          element.arrayIndices = [matched];
        }
        matched = true;
      }

      // If some element matched, and it's tagged with array indices, include
      // those indices in our result object.
      if (matched && element.arrayIndices) {
        match.arrayIndices = element.arrayIndices;
      }
      return matched;
    });
    return match;
  };
}

// Helpers for $near.
function distanceCoordinatePairs(a, b) {
  const pointA = pointToArray(a);
  const pointB = pointToArray(b);
  return Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1]);
}

// Takes something that is not an operator object and returns an element matcher
// for equality with that thing.
function equalityElementMatcher(elementSelector) {
  if (isOperatorObject(elementSelector)) {
    throw Error('Can\'t create equalityValueSelector for operator object');
  }

  // Special-case: null and undefined are equal (if you got undefined in there
  // somewhere, or if you got it due to some branch being non-existent in the
  // weird special case), even though they aren't with EJSON.equals.
  // undefined or null
  if (elementSelector == null) {
    return value => value == null;
  }
  return value => LocalCollection._f._equal(elementSelector, value);
}
function everythingMatcher(docOrBranchedValues) {
  return {
    result: true
  };
}
function expandArraysInBranches(branches, skipTheArrays) {
  const branchesOut = [];
  branches.forEach(branch => {
    const thisIsArray = Array.isArray(branch.value);

    // We include the branch itself, *UNLESS* we it's an array that we're going
    // to iterate and we're told to skip arrays.  (That's right, we include some
    // arrays even skipTheArrays is true: these are arrays that were found via
    // explicit numerical indices.)
    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {
      branchesOut.push({
        arrayIndices: branch.arrayIndices,
        value: branch.value
      });
    }
    if (thisIsArray && !branch.dontIterate) {
      branch.value.forEach((value, i) => {
        branchesOut.push({
          arrayIndices: (branch.arrayIndices || []).concat(i),
          value
        });
      });
    }
  });
  return branchesOut;
}
// Helpers for $bitsAllSet/$bitsAnySet/$bitsAllClear/$bitsAnyClear.
function getOperandBitmask(operand, selector) {
  // numeric bitmask
  // You can provide a numeric bitmask to be matched against the operand field.
  // It must be representable as a non-negative 32-bit signed integer.
  // Otherwise, $bitsAllSet will return an error.
  if (Number.isInteger(operand) && operand >= 0) {
    return new Uint8Array(new Int32Array([operand]).buffer);
  }

  // bindata bitmask
  // You can also use an arbitrarily large BinData instance as a bitmask.
  if (EJSON.isBinary(operand)) {
    return new Uint8Array(operand.buffer);
  }

  // position list
  // If querying a list of bit positions, each <position> must be a non-negative
  // integer. Bit positions start at 0 from the least significant bit.
  if (Array.isArray(operand) && operand.every(x => Number.isInteger(x) && x >= 0)) {
    const buffer = new ArrayBuffer((Math.max(...operand) >> 3) + 1);
    const view = new Uint8Array(buffer);
    operand.forEach(x => {
      view[x >> 3] |= 1 << (x & 0x7);
    });
    return view;
  }

  // bad operand
  throw Error("operand to ".concat(selector, " must be a numeric bitmask (representable as a ") + 'non-negative 32-bit signed integer), a bindata bitmask or an array with ' + 'bit positions (non-negative integers)');
}
function getValueBitmask(value, length) {
  // The field value must be either numerical or a BinData instance. Otherwise,
  // $bits... will not match the current document.

  // numerical
  if (Number.isSafeInteger(value)) {
    // $bits... will not match numerical values that cannot be represented as a
    // signed 64-bit integer. This can be the case if a value is either too
    // large or small to fit in a signed 64-bit integer, or if it has a
    // fractional component.
    const buffer = new ArrayBuffer(Math.max(length, 2 * Uint32Array.BYTES_PER_ELEMENT));
    let view = new Uint32Array(buffer, 0, 2);
    view[0] = value % ((1 << 16) * (1 << 16)) | 0;
    view[1] = value / ((1 << 16) * (1 << 16)) | 0;

    // sign extension
    if (value < 0) {
      view = new Uint8Array(buffer, 2);
      view.forEach((byte, i) => {
        view[i] = 0xff;
      });
    }
    return new Uint8Array(buffer);
  }

  // bindata
  if (EJSON.isBinary(value)) {
    return new Uint8Array(value.buffer);
  }

  // no match
  return false;
}

// Actually inserts a key value into the selector document
// However, this checks there is no ambiguity in setting
// the value for the given key, throws otherwise
function insertIntoDocument(document, key, value) {
  Object.keys(document).forEach(existingKey => {
    if (existingKey.length > key.length && existingKey.indexOf("".concat(key, ".")) === 0 || key.length > existingKey.length && key.indexOf("".concat(existingKey, ".")) === 0) {
      throw new Error("cannot infer query fields to set, both paths '".concat(existingKey, "' and ") + "'".concat(key, "' are matched"));
    } else if (existingKey === key) {
      throw new Error("cannot infer query fields to set, path '".concat(key, "' is matched twice"));
    }
  });
  document[key] = value;
}

// Returns a branched matcher that matches iff the given matcher does not.
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it
// means that ALL branch values need to fail to match innerBranchedMatcher.
function invertBranchedMatcher(branchedMatcher) {
  return branchValues => {
    // We explicitly choose to strip arrayIndices here: it doesn't make sense to
    // say "update the array element that does not match something", at least
    // in mongo-land.
    return {
      result: !branchedMatcher(branchValues).result
    };
  };
}
function isIndexable(obj) {
  return Array.isArray(obj) || LocalCollection._isPlainObject(obj);
}
function isNumericKey(s) {
  return /^[0-9]+$/.test(s);
}
function isOperatorObject(valueSelector, inconsistentOK) {
  if (!LocalCollection._isPlainObject(valueSelector)) {
    return false;
  }
  let theseAreOperators = undefined;
  Object.keys(valueSelector).forEach(selKey => {
    const thisIsOperator = selKey.substr(0, 1) === '$' || selKey === 'diff';
    if (theseAreOperators === undefined) {
      theseAreOperators = thisIsOperator;
    } else if (theseAreOperators !== thisIsOperator) {
      if (!inconsistentOK) {
        throw new Error("Inconsistent operator: ".concat(JSON.stringify(valueSelector)));
      }
      theseAreOperators = false;
    }
  });
  return !!theseAreOperators; // {} has no operators
}

// Helper for $lt/$gt/$lte/$gte.
function makeInequality(cmpValueComparator) {
  return {
    compileElementSelector(operand) {
      // Arrays never compare false with non-arrays for any inequality.
      // XXX This was behavior we observed in pre-release MongoDB 2.5, but
      //     it seems to have been reverted.
      //     See https://jira.mongodb.org/browse/SERVER-11444
      if (Array.isArray(operand)) {
        return () => false;
      }

      // Special case: consider undefined and null the same (so true with
      // $gte/$lte).
      if (operand === undefined) {
        operand = null;
      }
      const operandType = LocalCollection._f._type(operand);
      return value => {
        if (value === undefined) {
          value = null;
        }

        // Comparisons are never true among things of different type (except
        // null vs undefined).
        if (LocalCollection._f._type(value) !== operandType) {
          return false;
        }
        return cmpValueComparator(LocalCollection._f._cmp(value, operand));
      };
    }
  };
}

// makeLookupFunction(key) returns a lookup function.
//
// A lookup function takes in a document and returns an array of matching
// branches.  If no arrays are found while looking up the key, this array will
// have exactly one branches (possibly 'undefined', if some segment of the key
// was not found).
//
// If arrays are found in the middle, this can have more than one element, since
// we 'branch'. When we 'branch', if there are more key segments to look up,
// then we only pursue branches that are plain objects (not arrays or scalars).
// This means we can actually end up with no branches!
//
// We do *NOT* branch on arrays that are found at the end (ie, at the last
// dotted member of the key). We just return that array; if you want to
// effectively 'branch' over the array's values, post-process the lookup
// function with expandArraysInBranches.
//
// Each branch is an object with keys:
//  - value: the value at the branch
//  - dontIterate: an optional bool; if true, it means that 'value' is an array
//    that expandArraysInBranches should NOT expand. This specifically happens
//    when there is a numeric index in the key, and ensures the
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT
//    match {a: [[5]]}.
//  - arrayIndices: if any array indexing was done during lookup (either due to
//    explicit numeric indices or implicit branching), this will be an array of
//    the array indices used, from outermost to innermost; it is falsey or
//    absent if no array index is used. If an explicit numeric index is used,
//    the index will be followed in arrayIndices by the string 'x'.
//
//    Note: arrayIndices is used for two purposes. First, it is used to
//    implement the '$' modifier feature, which only ever looks at its first
//    element.
//
//    Second, it is used for sort key generation, which needs to be able to tell
//    the difference between different paths. Moreover, it needs to
//    differentiate between explicit and implicit branching, which is why
//    there's the somewhat hacky 'x' entry: this means that explicit and
//    implicit array lookups will have different full arrayIndices paths. (That
//    code only requires that different paths have different arrayIndices; it
//    doesn't actually 'parse' arrayIndices. As an alternative, arrayIndices
//    could contain objects with flags like 'implicit', but I think that only
//    makes the code surrounding them more complex.)
//
//    (By the way, this field ends up getting passed around a lot without
//    cloning, so never mutate any arrayIndices field/var in this package!)
//
//
// At the top level, you may only pass in a plain object or array.
//
// See the test 'minimongo - lookup' for some examples of what lookup functions
// return.
function makeLookupFunction(key) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  const parts = key.split('.');
  const firstPart = parts.length ? parts[0] : '';
  const lookupRest = parts.length > 1 && makeLookupFunction(parts.slice(1).join('.'), options);
  function buildResult(arrayIndices, dontIterate, value) {
    return arrayIndices && arrayIndices.length ? dontIterate ? [{
      arrayIndices,
      dontIterate,
      value
    }] : [{
      arrayIndices,
      value
    }] : dontIterate ? [{
      dontIterate,
      value
    }] : [{
      value
    }];
  }

  // Doc will always be a plain object or an array.
  // apply an explicit numeric index, an array.
  return (doc, arrayIndices) => {
    if (Array.isArray(doc)) {
      // If we're being asked to do an invalid lookup into an array (non-integer
      // or out-of-bounds), return no results (which is different from returning
      // a single undefined result, in that `null` equality checks won't match).
      if (!(isNumericKey(firstPart) && firstPart < doc.length)) {
        return [];
      }

      // Remember that we used this array index. Include an 'x' to indicate that
      // the previous index came from being considered as an explicit array
      // index (not branching).
      arrayIndices = arrayIndices ? arrayIndices.concat(+firstPart, 'x') : [+firstPart, 'x'];
    }

    // Do our first lookup.
    const firstLevel = doc[firstPart];

    // If there is no deeper to dig, return what we found.
    //
    // If what we found is an array, most value selectors will choose to treat
    // the elements of the array as matchable values in their own right, but
    // that's done outside of the lookup function. (Exceptions to this are $size
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:
    // [[1, 2]]}.)
    //
    // That said, if we just did an *explicit* array lookup (on doc) to find
    // firstLevel, and firstLevel is an array too, we do NOT want value
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.
    // So in that case, we mark the return value as 'don't iterate'.
    if (!lookupRest) {
      return buildResult(arrayIndices, Array.isArray(doc) && Array.isArray(firstLevel), firstLevel);
    }

    // We need to dig deeper.  But if we can't, because what we've found is not
    // an array or plain object, we're done. If we just did a numeric index into
    // an array, we return nothing here (this is a change in Mongo 2.5 from
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,
    // return a single `undefined` (which can, for example, match via equality
    // with `null`).
    if (!isIndexable(firstLevel)) {
      if (Array.isArray(doc)) {
        return [];
      }
      return buildResult(arrayIndices, false, undefined);
    }
    const result = [];
    const appendToResult = more => {
      result.push(...more);
    };

    // Dig deeper: look up the rest of the parts on whatever we've found.
    // (lookupRest is smart enough to not try to do invalid lookups into
    // firstLevel if it's an array.)
    appendToResult(lookupRest(firstLevel, arrayIndices));

    // If we found an array, then in *addition* to potentially treating the next
    // part as a literal integer lookup, we should also 'branch': try to look up
    // the rest of the parts on each array element in parallel.
    //
    // In this case, we *only* dig deeper into array elements that are plain
    // objects. (Recall that we only got this far if we have further to dig.)
    // This makes sense: we certainly don't dig deeper into non-indexable
    // objects. And it would be weird to dig into an array: it's simpler to have
    // a rule that explicit integer indexes only apply to an outer array, not to
    // an array you find after a branching search.
    //
    // In the special case of a numeric part in a *sort selector* (not a query
    // selector), we skip the branching: we ONLY allow the numeric part to mean
    // 'look up this index' in that case, not 'also look up this index in all
    // the elements of the array'.
    if (Array.isArray(firstLevel) && !(isNumericKey(parts[1]) && options.forSort)) {
      firstLevel.forEach((branch, arrayIndex) => {
        if (LocalCollection._isPlainObject(branch)) {
          appendToResult(lookupRest(branch, arrayIndices ? arrayIndices.concat(arrayIndex) : [arrayIndex]));
        }
      });
    }
    return result;
  };
}
// Object exported only for unit testing.
// Use it to export private functions to test in Tinytest.
MinimongoTest = {
  makeLookupFunction
};
MinimongoError = function (message) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  if (typeof message === 'string' && options.field) {
    message += " for field '".concat(options.field, "'");
  }
  const error = new Error(message);
  error.name = 'MinimongoError';
  return error;
};
function nothingMatcher(docOrBranchedValues) {
  return {
    result: false
  };
}
// Takes an operator object (an object with $ keys) and returns a branched
// matcher for it.
function operatorBranchedMatcher(valueSelector, matcher, isRoot) {
  // Each valueSelector works separately on the various branches.  So one
  // operator can match one branch and another can match another branch.  This
  // is OK.
  const operatorMatchers = Object.keys(valueSelector).map(operator => {
    const operand = valueSelector[operator];
    const simpleRange = ['$lt', '$lte', '$gt', '$gte'].includes(operator) && typeof operand === 'number';
    const simpleEquality = ['$ne', '$eq'].includes(operator) && operand !== Object(operand);
    const simpleInclusion = ['$in', '$nin'].includes(operator) && Array.isArray(operand) && !operand.some(x => x === Object(x));
    if (!(simpleRange || simpleInclusion || simpleEquality)) {
      matcher._isSimple = false;
    }
    if (hasOwn.call(VALUE_OPERATORS, operator)) {
      return VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot);
    }
    if (hasOwn.call(ELEMENT_OPERATORS, operator)) {
      const options = ELEMENT_OPERATORS[operator];
      return convertElementMatcherToBranchedMatcher(options.compileElementSelector(operand, valueSelector, matcher), options);
    }
    throw new Error("Unrecognized operator: ".concat(operator));
  });
  return andBranchedMatchers(operatorMatchers);
}

// paths - Array: list of mongo style paths
// newLeafFn - Function: of form function(path) should return a scalar value to
//                       put into list created for that path
// conflictFn - Function: of form function(node, path, fullPath) is called
//                        when building a tree path for 'fullPath' node on
//                        'path' was already a leaf with a value. Must return a
//                        conflict resolution.
// initial tree - Optional Object: starting tree.
// @returns - Object: tree represented as a set of nested objects
function pathsToTree(paths, newLeafFn, conflictFn) {
  let root = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};
  paths.forEach(path => {
    const pathArray = path.split('.');
    let tree = root;

    // use .every just for iteration with break
    const success = pathArray.slice(0, -1).every((key, i) => {
      if (!hasOwn.call(tree, key)) {
        tree[key] = {};
      } else if (tree[key] !== Object(tree[key])) {
        tree[key] = conflictFn(tree[key], pathArray.slice(0, i + 1).join('.'), path);

        // break out of loop if we are failing for this path
        if (tree[key] !== Object(tree[key])) {
          return false;
        }
      }
      tree = tree[key];
      return true;
    });
    if (success) {
      const lastKey = pathArray[pathArray.length - 1];
      if (hasOwn.call(tree, lastKey)) {
        tree[lastKey] = conflictFn(tree[lastKey], path, path);
      } else {
        tree[lastKey] = newLeafFn(path);
      }
    }
  });
  return root;
}
// Makes sure we get 2 elements array and assume the first one to be x and
// the second one to y no matter what user passes.
// In case user passes { lon: x, lat: y } returns [x, y]
function pointToArray(point) {
  return Array.isArray(point) ? point.slice() : [point.x, point.y];
}

// Creating a document from an upsert is quite tricky.
// E.g. this selector: {"$or": [{"b.foo": {"$all": ["bar"]}}]}, should result
// in: {"b.foo": "bar"}
// But this selector: {"$or": [{"b": {"foo": {"$all": ["bar"]}}}]} should throw
// an error

// Some rules (found mainly with trial & error, so there might be more):
// - handle all childs of $and (or implicit $and)
// - handle $or nodes with exactly 1 child
// - ignore $or nodes with more than 1 child
// - ignore $nor and $not nodes
// - throw when a value can not be set unambiguously
// - every value for $all should be dealt with as separate $eq-s
// - threat all children of $all as $eq setters (=> set if $all.length === 1,
//   otherwise throw error)
// - you can not mix '$'-prefixed keys and non-'$'-prefixed keys
// - you can only have dotted keys on a root-level
// - you can not have '$'-prefixed keys more than one-level deep in an object

// Handles one key/value pair to put in the selector document
function populateDocumentWithKeyValue(document, key, value) {
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    populateDocumentWithObject(document, key, value);
  } else if (!(value instanceof RegExp)) {
    insertIntoDocument(document, key, value);
  }
}

// Handles a key, value pair to put in the selector document
// if the value is an object
function populateDocumentWithObject(document, key, value) {
  const keys = Object.keys(value);
  const unprefixedKeys = keys.filter(op => op[0] !== '$');
  if (unprefixedKeys.length > 0 || !keys.length) {
    // Literal (possibly empty) object ( or empty object )
    // Don't allow mixing '$'-prefixed with non-'$'-prefixed fields
    if (keys.length !== unprefixedKeys.length) {
      throw new Error("unknown operator: ".concat(unprefixedKeys[0]));
    }
    validateObject(value, key);
    insertIntoDocument(document, key, value);
  } else {
    Object.keys(value).forEach(op => {
      const object = value[op];
      if (op === '$eq') {
        populateDocumentWithKeyValue(document, key, object);
      } else if (op === '$all') {
        // every value for $all should be dealt with as separate $eq-s
        object.forEach(element => populateDocumentWithKeyValue(document, key, element));
      }
    });
  }
}

// Fills a document with certain fields from an upsert selector
function populateDocumentWithQueryFields(query) {
  let document = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  if (Object.getPrototypeOf(query) === Object.prototype) {
    // handle implicit $and
    Object.keys(query).forEach(key => {
      const value = query[key];
      if (key === '$and') {
        // handle explicit $and
        value.forEach(element => populateDocumentWithQueryFields(element, document));
      } else if (key === '$or') {
        // handle $or nodes with exactly 1 child
        if (value.length === 1) {
          populateDocumentWithQueryFields(value[0], document);
        }
      } else if (key[0] !== '$') {
        // Ignore other '$'-prefixed logical selectors
        populateDocumentWithKeyValue(document, key, value);
      }
    });
  } else {
    // Handle meteor-specific shortcut for selecting _id
    if (LocalCollection._selectorIsId(query)) {
      insertIntoDocument(document, '_id', query);
    }
  }
  return document;
}
function projectionDetails(fields) {
  // Find the non-_id keys (_id is handled specially because it is included
  // unless explicitly excluded). Sort the keys, so that our code to detect
  // overlaps like 'foo' and 'foo.bar' can assume that 'foo' comes first.
  let fieldsKeys = Object.keys(fields).sort();

  // If _id is the only field in the projection, do not remove it, since it is
  // required to determine if this is an exclusion or exclusion. Also keep an
  // inclusive _id, since inclusive _id follows the normal rules about mixing
  // inclusive and exclusive fields. If _id is not the only field in the
  // projection and is exclusive, remove it so it can be handled later by a
  // special case, since exclusive _id is always allowed.
  if (!(fieldsKeys.length === 1 && fieldsKeys[0] === '_id') && !(fieldsKeys.includes('_id') && fields._id)) {
    fieldsKeys = fieldsKeys.filter(key => key !== '_id');
  }
  let including = null; // Unknown

  fieldsKeys.forEach(keyPath => {
    const rule = !!fields[keyPath];
    if (including === null) {
      including = rule;
    }

    // This error message is copied from MongoDB shell
    if (including !== rule) {
      throw MinimongoError('You cannot currently mix including and excluding fields.');
    }
  });
  const projectionRulesTree = pathsToTree(fieldsKeys, path => including, (node, path, fullPath) => {
    // Check passed projection fields' keys: If you have two rules such as
    // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If
    // that happens, there is a probability you are doing something wrong,
    // framework should notify you about such mistake earlier on cursor
    // compilation step than later during runtime.  Note, that real mongo
    // doesn't do anything about it and the later rule appears in projection
    // project, more priority it takes.
    //
    // Example, assume following in mongo shell:
    // > db.coll.insert({ a: { b: 23, c: 44 } })
    // > db.coll.find({}, { 'a': 1, 'a.b': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23}}
    // > db.coll.find({}, { 'a.b': 1, 'a': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23, "c": 44}}
    //
    // Note, how second time the return set of keys is different.
    const currentPath = fullPath;
    const anotherPath = path;
    throw MinimongoError("both ".concat(currentPath, " and ").concat(anotherPath, " found in fields option, ") + 'using both of them may trigger unexpected behavior. Did you mean to ' + 'use only one of them?');
  });
  return {
    including,
    tree: projectionRulesTree
  };
}
function regexpElementMatcher(regexp) {
  return value => {
    if (value instanceof RegExp) {
      return value.toString() === regexp.toString();
    }

    // Regexps only work against strings.
    if (typeof value !== 'string') {
      return false;
    }

    // Reset regexp's state to avoid inconsistent matching for objects with the
    // same value on consecutive calls of regexp.test. This happens only if the
    // regexp has the 'g' flag. Also note that ES6 introduces a new flag 'y' for
    // which we should *not* change the lastIndex but MongoDB doesn't support
    // either of these flags.
    regexp.lastIndex = 0;
    return regexp.test(value);
  };
}
// Validates the key in a path.
// Objects that are nested more then 1 level cannot have dotted fields
// or fields starting with '$'
function validateKeyInPath(key, path) {
  if (key.includes('.')) {
    throw new Error("The dotted field '".concat(key, "' in '").concat(path, ".").concat(key, " is not valid for storage."));
  }
  if (key[0] === '$') {
    throw new Error("The dollar ($) prefixed field  '".concat(path, ".").concat(key, " is not valid for storage."));
  }
}

// Recursively validates an object that is nested more than one level deep
function validateObject(object, path) {
  if (object && Object.getPrototypeOf(object) === Object.prototype) {
    Object.keys(object).forEach(key => {
      validateKeyInPath(key, path);
      validateObject(object[key], path + '.' + key);
    });
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"constants.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/constants.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  getAsyncMethodName: () => getAsyncMethodName,
  ASYNC_COLLECTION_METHODS: () => ASYNC_COLLECTION_METHODS,
  ASYNC_CURSOR_METHODS: () => ASYNC_CURSOR_METHODS
});
function getAsyncMethodName(method) {
  return "".concat(method.replace('_', ''), "Async");
}
const ASYNC_COLLECTION_METHODS = ['_createCappedCollection', '_dropCollection', '_dropIndex', 'createIndex', 'findOne', 'insert', 'remove', 'update', 'upsert'];
const ASYNC_CURSOR_METHODS = ['count', 'fetch', 'forEach', 'map'];
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"cursor.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/cursor.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Cursor
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }
}, 0);
let hasOwn;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  }
}, 1);
let ASYNC_CURSOR_METHODS, getAsyncMethodName;
module.link("./constants", {
  ASYNC_CURSOR_METHODS(v) {
    ASYNC_CURSOR_METHODS = v;
  },
  getAsyncMethodName(v) {
    getAsyncMethodName = v;
  }
}, 2);
class Cursor {
  // don't call this ctor directly.  use LocalCollection.find().
  constructor(collection, selector) {
    let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
    this.collection = collection;
    this.sorter = null;
    this.matcher = new Minimongo.Matcher(selector);
    if (LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
      // stash for fast _id and { _id }
      this._selectorId = hasOwn.call(selector, '_id') ? selector._id : selector;
    } else {
      this._selectorId = undefined;
      if (this.matcher.hasGeoQuery() || options.sort) {
        this.sorter = new Minimongo.Sorter(options.sort || []);
      }
    }
    this.skip = options.skip || 0;
    this.limit = options.limit;
    this.fields = options.projection || options.fields;
    this._projectionFn = LocalCollection._compileProjection(this.fields || {});
    this._transform = LocalCollection.wrapTransform(options.transform);

    // by default, queries register w/ Tracker when it is available.
    if (typeof Tracker !== 'undefined') {
      this.reactive = options.reactive === undefined ? true : options.reactive;
    }
  }

  /**
   * @deprecated in 2.9
   * @summary Returns the number of documents that match a query. This method is
   *          [deprecated since MongoDB 4.0](https://www.mongodb.com/docs/v4.4/reference/command/count/);
   *          see `Collection.countDocuments` and
   *          `Collection.estimatedDocumentCount` for a replacement.
   * @memberOf Mongo.Cursor
   * @method  count
   * @instance
   * @locus Anywhere
   * @returns {Number}
   */
  count() {
    if (this.reactive) {
      // allow the observe to be unordered
      this._depend({
        added: true,
        removed: true
      }, true);
    }
    return this._getRawObjects({
      ordered: true
    }).length;
  }

  /**
   * @summary Return all matching documents as an Array.
   * @memberOf Mongo.Cursor
   * @method  fetch
   * @instance
   * @locus Anywhere
   * @returns {Object[]}
   */
  fetch() {
    const result = [];
    this.forEach(doc => {
      result.push(doc);
    });
    return result;
  }
  [Symbol.iterator]() {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }
    let index = 0;
    const objects = this._getRawObjects({
      ordered: true
    });
    return {
      next: () => {
        if (index < objects.length) {
          // This doubles as a clone operation.
          let element = this._projectionFn(objects[index++]);
          if (this._transform) element = this._transform(element);
          return {
            value: element
          };
        }
        return {
          done: true
        };
      }
    };
  }
  [Symbol.asyncIterator]() {
    const syncResult = this[Symbol.iterator]();
    return {
      next() {
        return Promise.asyncApply(() => {
          return Promise.resolve(syncResult.next());
        });
      }
    };
  }

  /**
   * @callback IterationCallback
   * @param {Object} doc
   * @param {Number} index
   */
  /**
   * @summary Call `callback` once for each matching document, sequentially and
   *          synchronously.
   * @locus Anywhere
   * @method  forEach
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */
  forEach(callback, thisArg) {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }
    this._getRawObjects({
      ordered: true
    }).forEach((element, i) => {
      // This doubles as a clone operation.
      element = this._projectionFn(element);
      if (this._transform) {
        element = this._transform(element);
      }
      callback.call(thisArg, element, i, this);
    });
  }
  getTransform() {
    return this._transform;
  }

  /**
   * @summary Map callback over all matching documents.  Returns an Array.
   * @locus Anywhere
   * @method map
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */
  map(callback, thisArg) {
    const result = [];
    this.forEach((doc, i) => {
      result.push(callback.call(thisArg, doc, i, this));
    });
    return result;
  }

  // options to contain:
  //  * callbacks for observe():
  //    - addedAt (document, atIndex)
  //    - added (document)
  //    - changedAt (newDocument, oldDocument, atIndex)
  //    - changed (newDocument, oldDocument)
  //    - removedAt (document, atIndex)
  //    - removed (document)
  //    - movedTo (document, oldIndex, newIndex)
  //
  // attributes available on returned query handle:
  //  * stop(): end updates
  //  * collection: the collection this query is querying
  //
  // iff x is a returned query handle, (x instanceof
  // LocalCollection.ObserveHandle) is true
  //
  // initial results delivered through added callback
  // XXX maybe callbacks should take a list of objects, to expose transactions?
  // XXX maybe support field limiting (to limit what you're notified on)

  /**
   * @summary Watch a query.  Receive callbacks as the result set changes.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */
  observe(options) {
    return LocalCollection._observeFromObserveChanges(this, options);
  }

  /**
   * @summary Watch a query. Receive callbacks as the result set changes. Only
   *          the differences between the old and new documents are passed to
   *          the callbacks.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */
  observeChanges(options) {
    const ordered = LocalCollection._observeChangesCallbacksAreOrdered(options);

    // there are several places that assume you aren't combining skip/limit with
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"
    // comment in _modifyAndNotify
    // XXX allow skip/limit with unordered observe
    if (!options._allow_unordered && !ordered && (this.skip || this.limit)) {
      throw new Error("Must use an ordered observe with skip or limit (i.e. 'addedBefore' " + "for observeChanges or 'addedAt' for observe, instead of 'added').");
    }
    if (this.fields && (this.fields._id === 0 || this.fields._id === false)) {
      throw Error('You may not observe a cursor with {fields: {_id: 0}}');
    }
    const distances = this.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap();
    const query = {
      cursor: this,
      dirty: false,
      distances,
      matcher: this.matcher,
      // not fast pathed
      ordered,
      projectionFn: this._projectionFn,
      resultsSnapshot: null,
      sorter: ordered && this.sorter
    };
    let qid;

    // Non-reactive queries call added[Before] and then never call anything
    // else.
    if (this.reactive) {
      qid = this.collection.next_qid++;
      this.collection.queries[qid] = query;
    }
    query.results = this._getRawObjects({
      ordered,
      distances: query.distances
    });
    if (this.collection.paused) {
      query.resultsSnapshot = ordered ? [] : new LocalCollection._IdMap();
    }

    // wrap callbacks we were passed. callbacks only fire when not paused and
    // are never undefined
    // Filters out blacklisted fields according to cursor's projection.
    // XXX wrong place for this?

    // furthermore, callbacks enqueue until the operation we're working on is
    // done.
    const wrapCallback = fn => {
      if (!fn) {
        return () => {};
      }
      const self = this;
      return function /* args*/
      () {
        if (self.collection.paused) {
          return;
        }
        const args = arguments;
        self.collection._observeQueue.queueTask(() => {
          fn.apply(this, args);
        });
      };
    };
    query.added = wrapCallback(options.added);
    query.changed = wrapCallback(options.changed);
    query.removed = wrapCallback(options.removed);
    if (ordered) {
      query.addedBefore = wrapCallback(options.addedBefore);
      query.movedBefore = wrapCallback(options.movedBefore);
    }
    if (!options._suppress_initial && !this.collection.paused) {
      query.results.forEach(doc => {
        const fields = EJSON.clone(doc);
        delete fields._id;
        if (ordered) {
          query.addedBefore(doc._id, this._projectionFn(fields), null);
        }
        query.added(doc._id, this._projectionFn(fields));
      });
    }
    const handle = Object.assign(new LocalCollection.ObserveHandle(), {
      collection: this.collection,
      stop: () => {
        if (this.reactive) {
          delete this.collection.queries[qid];
        }
      }
    });
    if (this.reactive && Tracker.active) {
      // XXX in many cases, the same observe will be recreated when
      // the current autorun is rerun.  we could save work by
      // letting it linger across rerun and potentially get
      // repurposed if the same observe is performed, using logic
      // similar to that of Meteor.subscribe.
      Tracker.onInvalidate(() => {
        handle.stop();
      });
    }

    // run the observe callbacks resulting from the initial contents
    // before we leave the observe.
    this.collection._observeQueue.drain();
    return handle;
  }

  // XXX Maybe we need a version of observe that just calls a callback if
  // anything changed.
  _depend(changers, _allow_unordered) {
    if (Tracker.active) {
      const dependency = new Tracker.Dependency();
      const notify = dependency.changed.bind(dependency);
      dependency.depend();
      const options = {
        _allow_unordered,
        _suppress_initial: true
      };
      ['added', 'addedBefore', 'changed', 'movedBefore', 'removed'].forEach(fn => {
        if (changers[fn]) {
          options[fn] = notify;
        }
      });

      // observeChanges will stop() when this computation is invalidated
      this.observeChanges(options);
    }
  }
  _getCollectionName() {
    return this.collection.name;
  }

  // Returns a collection of matching objects, but doesn't deep copy them.
  //
  // If ordered is set, returns a sorted array, respecting sorter, skip, and
  // limit properties of the query provided that options.applySkipLimit is
  // not set to false (#1201). If sorter is falsey, no sort -- you get the
  // natural order.
  //
  // If ordered is not set, returns an object mapping from ID to doc (sorter,
  // skip and limit should not be set).
  //
  // If ordered is set and this cursor is a $near geoquery, then this function
  // will use an _IdMap to track each distance from the $near argument point in
  // order to use it as a sort key. If an _IdMap is passed in the 'distances'
  // argument, this function will clear it and use it for this purpose
  // (otherwise it will just create its own _IdMap). The observeChanges
  // implementation uses this to remember the distances after this function
  // returns.
  _getRawObjects() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    // By default this method will respect skip and limit because .fetch(),
    // .forEach() etc... expect this behaviour. It can be forced to ignore
    // skip and limit by setting applySkipLimit to false (.count() does this,
    // for example)
    const applySkipLimit = options.applySkipLimit !== false;

    // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
    // compatible
    const results = options.ordered ? [] : new LocalCollection._IdMap();

    // fast path for single ID value
    if (this._selectorId !== undefined) {
      // If you have non-zero skip and ask for a single id, you get nothing.
      // This is so it matches the behavior of the '{_id: foo}' path.
      if (applySkipLimit && this.skip) {
        return results;
      }
      const selectedDoc = this.collection._docs.get(this._selectorId);
      if (selectedDoc) {
        if (options.ordered) {
          results.push(selectedDoc);
        } else {
          results.set(this._selectorId, selectedDoc);
        }
      }
      return results;
    }

    // slow path for arbitrary selector, sort, skip, limit

    // in the observeChanges case, distances is actually part of the "query"
    // (ie, live results set) object.  in other cases, distances is only used
    // inside this function.
    let distances;
    if (this.matcher.hasGeoQuery() && options.ordered) {
      if (options.distances) {
        distances = options.distances;
        distances.clear();
      } else {
        distances = new LocalCollection._IdMap();
      }
    }
    this.collection._docs.forEach((doc, id) => {
      const matchResult = this.matcher.documentMatches(doc);
      if (matchResult.result) {
        if (options.ordered) {
          results.push(doc);
          if (distances && matchResult.distance !== undefined) {
            distances.set(id, matchResult.distance);
          }
        } else {
          results.set(id, doc);
        }
      }

      // Override to ensure all docs are matched if ignoring skip & limit
      if (!applySkipLimit) {
        return true;
      }

      // Fast path for limited unsorted queries.
      // XXX 'length' check here seems wrong for ordered
      return !this.limit || this.skip || this.sorter || results.length !== this.limit;
    });
    if (!options.ordered) {
      return results;
    }
    if (this.sorter) {
      results.sort(this.sorter.getComparator({
        distances
      }));
    }

    // Return the full set of results if there is no skip or limit or if we're
    // ignoring them
    if (!applySkipLimit || !this.limit && !this.skip) {
      return results;
    }
    return results.slice(this.skip, this.limit ? this.limit + this.skip : results.length);
  }
  _publishCursor(subscription) {
    // XXX minimongo should not depend on mongo-livedata!
    if (!Package.mongo) {
      throw new Error('Can\'t publish from Minimongo without the `mongo` package.');
    }
    if (!this.collection.name) {
      throw new Error('Can\'t publish a cursor from a collection without a name.');
    }
    return Package.mongo.Mongo.Collection._publishCursor(this, subscription, this.collection.name);
  }
}
// Implements async version of cursor methods to keep collections isomorphic
ASYNC_CURSOR_METHODS.forEach(method => {
  const asyncName = getAsyncMethodName(method);
  Cursor.prototype[asyncName] = function () {
    try {
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      return Promise.resolve(this[method].apply(this, args));
    } catch (error) {
      return Promise.reject(error);
    }
  };
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/local_collection.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let _objectSpread;
module.link("@babel/runtime/helpers/objectSpread2", {
  default(v) {
    _objectSpread = v;
  }
}, 0);
module.export({
  default: () => LocalCollection
});
let Cursor;
module.link("./cursor.js", {
  default(v) {
    Cursor = v;
  }
}, 0);
let ObserveHandle;
module.link("./observe_handle.js", {
  default(v) {
    ObserveHandle = v;
  }
}, 1);
let hasOwn, isIndexable, isNumericKey, isOperatorObject, populateDocumentWithQueryFields, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },
  isIndexable(v) {
    isIndexable = v;
  },
  isNumericKey(v) {
    isNumericKey = v;
  },
  isOperatorObject(v) {
    isOperatorObject = v;
  },
  populateDocumentWithQueryFields(v) {
    populateDocumentWithQueryFields = v;
  },
  projectionDetails(v) {
    projectionDetails = v;
  }
}, 2);
class LocalCollection {
  constructor(name) {
    this.name = name;
    // _id -> document (also containing id)
    this._docs = new LocalCollection._IdMap();
    this._observeQueue = new Meteor._SynchronousQueue();
    this.next_qid = 1; // live query id generator

    // qid -> live query object. keys:
    //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.
    //  results: array (ordered) or object (unordered) of current results
    //    (aliased with this._docs!)
    //  resultsSnapshot: snapshot of results. null if not paused.
    //  cursor: Cursor object for the query.
    //  selector, sorter, (callbacks): functions
    this.queries = Object.create(null);

    // null if not saving originals; an IdMap from id to original document value
    // if saving originals. See comments before saveOriginals().
    this._savedOriginals = null;

    // True when observers are paused and we should not send callbacks.
    this.paused = false;
  }
  countDocuments(selector, options) {
    return this.find(selector !== null && selector !== void 0 ? selector : {}, options).countAsync();
  }
  estimatedDocumentCount(options) {
    return this.find({}, options).countAsync();
  }

  // options may include sort, skip, limit, reactive
  // sort may be any of these forms:
  //     {a: 1, b: -1}
  //     [["a", "asc"], ["b", "desc"]]
  //     ["a", ["b", "desc"]]
  //   (in the first form you're beholden to key enumeration order in
  //   your javascript VM)
  //
  // reactive: if given, and false, don't register with Tracker (default
  // is true)
  //
  // XXX possibly should support retrieving a subset of fields? and
  // have it be a hint (ignored on the client, when not copying the
  // doc?)
  //
  // XXX sort does not yet support subkeys ('a.b') .. fix that!
  // XXX add one more sort form: "key"
  // XXX tests
  find(selector, options) {
    // default syntax for everything is to omit the selector argument.
    // but if selector is explicitly passed in as false or undefined, we
    // want a selector that matches nothing.
    if (arguments.length === 0) {
      selector = {};
    }
    return new LocalCollection.Cursor(this, selector, options);
  }
  findOne(selector) {
    let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    if (arguments.length === 0) {
      selector = {};
    }

    // NOTE: by setting limit 1 here, we end up using very inefficient
    // code that recomputes the whole query on each update. The upside is
    // that when you reactively depend on a findOne you only get
    // invalidated when the found object changes, not any object in the
    // collection. Most findOne will be by id, which has a fast path, so
    // this might not be a big deal. In most cases, invalidation causes
    // the called to re-query anyway, so this should be a net performance
    // improvement.
    options.limit = 1;
    return this.find(selector, options).fetch()[0];
  }

  // XXX possibly enforce that 'undefined' does not appear (we assume
  // this in our handling of null and $exists)
  insert(doc, callback) {
    doc = EJSON.clone(doc);
    assertHasValidFieldNames(doc);

    // if you really want to use ObjectIDs, set this global.
    // Mongo.Collection specifies its own ids and does not use this code.
    if (!hasOwn.call(doc, '_id')) {
      doc._id = LocalCollection._useOID ? new MongoID.ObjectID() : Random.id();
    }
    const id = doc._id;
    if (this._docs.has(id)) {
      throw MinimongoError("Duplicate _id '".concat(id, "'"));
    }
    this._saveOriginal(id, undefined);
    this._docs.set(id, doc);
    const queriesToRecompute = [];

    // trigger live queries that match
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      if (query.dirty) {
        return;
      }
      const matchResult = query.matcher.documentMatches(doc);
      if (matchResult.result) {
        if (query.distances && matchResult.distance !== undefined) {
          query.distances.set(id, matchResult.distance);
        }
        if (query.cursor.skip || query.cursor.limit) {
          queriesToRecompute.push(qid);
        } else {
          LocalCollection._insertInResults(query, doc);
        }
      }
    });
    queriesToRecompute.forEach(qid => {
      if (this.queries[qid]) {
        this._recomputeResults(this.queries[qid]);
      }
    });
    this._observeQueue.drain();

    // Defer because the caller likely doesn't expect the callback to be run
    // immediately.
    if (callback) {
      Meteor.defer(() => {
        callback(null, id);
      });
    }
    return id;
  }

  // Pause the observers. No callbacks from observers will fire until
  // 'resumeObservers' is called.
  pauseObservers() {
    // No-op if already paused.
    if (this.paused) {
      return;
    }

    // Set the 'paused' flag such that new observer messages don't fire.
    this.paused = true;

    // Take a snapshot of the query results for each query.
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      query.resultsSnapshot = EJSON.clone(query.results);
    });
  }
  remove(selector, callback) {
    // Easy special case: if we're not calling observeChanges callbacks and
    // we're not saving originals and we got asked to remove everything, then
    // just empty everything directly.
    if (this.paused && !this._savedOriginals && EJSON.equals(selector, {})) {
      const result = this._docs.size();
      this._docs.clear();
      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];
        if (query.ordered) {
          query.results = [];
        } else {
          query.results.clear();
        }
      });
      if (callback) {
        Meteor.defer(() => {
          callback(null, result);
        });
      }
      return result;
    }
    const matcher = new Minimongo.Matcher(selector);
    const remove = [];
    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      if (matcher.documentMatches(doc).result) {
        remove.push(id);
      }
    });
    const queriesToRecompute = [];
    const queryRemove = [];
    for (let i = 0; i < remove.length; i++) {
      const removeId = remove[i];
      const removeDoc = this._docs.get(removeId);
      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];
        if (query.dirty) {
          return;
        }
        if (query.matcher.documentMatches(removeDoc).result) {
          if (query.cursor.skip || query.cursor.limit) {
            queriesToRecompute.push(qid);
          } else {
            queryRemove.push({
              qid,
              doc: removeDoc
            });
          }
        }
      });
      this._saveOriginal(removeId, removeDoc);
      this._docs.remove(removeId);
    }

    // run live query callbacks _after_ we've removed the documents.
    queryRemove.forEach(remove => {
      const query = this.queries[remove.qid];
      if (query) {
        query.distances && query.distances.remove(remove.doc._id);
        LocalCollection._removeFromResults(query, remove.doc);
      }
    });
    queriesToRecompute.forEach(qid => {
      const query = this.queries[qid];
      if (query) {
        this._recomputeResults(query);
      }
    });
    this._observeQueue.drain();
    const result = remove.length;
    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }
    return result;
  }

  // Resume the observers. Observers immediately receive change
  // notifications to bring them to the current state of the
  // database. Note that this is not just replaying all the changes that
  // happened during the pause, it is a smarter 'coalesced' diff.
  resumeObservers() {
    // No-op if not paused.
    if (!this.paused) {
      return;
    }

    // Unset the 'paused' flag. Make sure to do this first, otherwise
    // observer methods won't actually fire when we trigger them.
    this.paused = false;
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      if (query.dirty) {
        query.dirty = false;

        // re-compute results will perform `LocalCollection._diffQueryChanges`
        // automatically.
        this._recomputeResults(query, query.resultsSnapshot);
      } else {
        // Diff the current results against the snapshot and send to observers.
        // pass the query object for its observer callbacks.
        LocalCollection._diffQueryChanges(query.ordered, query.resultsSnapshot, query.results, query, {
          projectionFn: query.projectionFn
        });
      }
      query.resultsSnapshot = null;
    });
    this._observeQueue.drain();
  }
  retrieveOriginals() {
    if (!this._savedOriginals) {
      throw new Error('Called retrieveOriginals without saveOriginals');
    }
    const originals = this._savedOriginals;
    this._savedOriginals = null;
    return originals;
  }

  // To track what documents are affected by a piece of code, call
  // saveOriginals() before it and retrieveOriginals() after it.
  // retrieveOriginals returns an object whose keys are the ids of the documents
  // that were affected since the call to saveOriginals(), and the values are
  // equal to the document's contents at the time of saveOriginals. (In the case
  // of an inserted document, undefined is the value.) You must alternate
  // between calls to saveOriginals() and retrieveOriginals().
  saveOriginals() {
    if (this._savedOriginals) {
      throw new Error('Called saveOriginals twice without retrieveOriginals');
    }
    this._savedOriginals = new LocalCollection._IdMap();
  }

  // XXX atomicity: if multi is true, and one modification fails, do
  // we rollback the whole operation, or what?
  update(selector, mod, options, callback) {
    if (!callback && options instanceof Function) {
      callback = options;
      options = null;
    }
    if (!options) {
      options = {};
    }
    const matcher = new Minimongo.Matcher(selector, true);

    // Save the original results of any query that we might need to
    // _recomputeResults on, because _modifyAndNotify will mutate the objects in
    // it. (We don't need to save the original results of paused queries because
    // they already have a resultsSnapshot and we won't be diffing in
    // _recomputeResults.)
    const qidToOriginalResults = {};

    // We should only clone each document once, even if it appears in multiple
    // queries
    const docMap = new LocalCollection._IdMap();
    const idsMatched = LocalCollection._idsMatchedBySelector(selector);
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      if ((query.cursor.skip || query.cursor.limit) && !this.paused) {
        // Catch the case of a reactive `count()` on a cursor with skip
        // or limit, which registers an unordered observe. This is a
        // pretty rare case, so we just clone the entire result set with
        // no optimizations for documents that appear in these result
        // sets and other queries.
        if (query.results instanceof LocalCollection._IdMap) {
          qidToOriginalResults[qid] = query.results.clone();
          return;
        }
        if (!(query.results instanceof Array)) {
          throw new Error('Assertion failed: query.results not an array');
        }

        // Clones a document to be stored in `qidToOriginalResults`
        // because it may be modified before the new and old result sets
        // are diffed. But if we know exactly which document IDs we're
        // going to modify, then we only need to clone those.
        const memoizedCloneIfNeeded = doc => {
          if (docMap.has(doc._id)) {
            return docMap.get(doc._id);
          }
          const docToMemoize = idsMatched && !idsMatched.some(id => EJSON.equals(id, doc._id)) ? doc : EJSON.clone(doc);
          docMap.set(doc._id, docToMemoize);
          return docToMemoize;
        };
        qidToOriginalResults[qid] = query.results.map(memoizedCloneIfNeeded);
      }
    });
    const recomputeQids = {};
    let updateCount = 0;
    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      const queryResult = matcher.documentMatches(doc);
      if (queryResult.result) {
        // XXX Should we save the original even if mod ends up being a no-op?
        this._saveOriginal(id, doc);
        this._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndices);
        ++updateCount;
        if (!options.multi) {
          return false; // break
        }
      }

      return true;
    });
    Object.keys(recomputeQids).forEach(qid => {
      const query = this.queries[qid];
      if (query) {
        this._recomputeResults(query, qidToOriginalResults[qid]);
      }
    });
    this._observeQueue.drain();

    // If we are doing an upsert, and we didn't modify any documents yet, then
    // it's time to do an insert. Figure out what document we are inserting, and
    // generate an id for it.
    let insertedId;
    if (updateCount === 0 && options.upsert) {
      const doc = LocalCollection._createUpsertDocument(selector, mod);
      if (!doc._id && options.insertedId) {
        doc._id = options.insertedId;
      }
      insertedId = this.insert(doc);
      updateCount = 1;
    }

    // Return the number of affected documents, or in the upsert case, an object
    // containing the number of affected docs and the id of the doc that was
    // inserted, if any.
    let result;
    if (options._returnObject) {
      result = {
        numberAffected: updateCount
      };
      if (insertedId !== undefined) {
        result.insertedId = insertedId;
      }
    } else {
      result = updateCount;
    }
    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }
    return result;
  }

  // A convenience wrapper on update. LocalCollection.upsert(sel, mod) is
  // equivalent to LocalCollection.update(sel, mod, {upsert: true,
  // _returnObject: true}).
  upsert(selector, mod, options, callback) {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    }
    return this.update(selector, mod, Object.assign({}, options, {
      upsert: true,
      _returnObject: true
    }), callback);
  }

  // Iterates over a subset of documents that could match selector; calls
  // fn(doc, id) on each of them.  Specifically, if selector specifies
  // specific _id's, it only looks at those.  doc is *not* cloned: it is the
  // same object that is in _docs.
  _eachPossiblyMatchingDoc(selector, fn) {
    const specificIds = LocalCollection._idsMatchedBySelector(selector);
    if (specificIds) {
      specificIds.some(id => {
        const doc = this._docs.get(id);
        if (doc) {
          return fn(doc, id) === false;
        }
      });
    } else {
      this._docs.forEach(fn);
    }
  }
  _modifyAndNotify(doc, mod, recomputeQids, arrayIndices) {
    const matched_before = {};
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      if (query.dirty) {
        return;
      }
      if (query.ordered) {
        matched_before[qid] = query.matcher.documentMatches(doc).result;
      } else {
        // Because we don't support skip or limit (yet) in unordered queries, we
        // can just do a direct lookup.
        matched_before[qid] = query.results.has(doc._id);
      }
    });
    const old_doc = EJSON.clone(doc);
    LocalCollection._modify(doc, mod, {
      arrayIndices
    });
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      if (query.dirty) {
        return;
      }
      const afterMatch = query.matcher.documentMatches(doc);
      const after = afterMatch.result;
      const before = matched_before[qid];
      if (after && query.distances && afterMatch.distance !== undefined) {
        query.distances.set(doc._id, afterMatch.distance);
      }
      if (query.cursor.skip || query.cursor.limit) {
        // We need to recompute any query where the doc may have been in the
        // cursor's window either before or after the update. (Note that if skip
        // or limit is set, "before" and "after" being true do not necessarily
        // mean that the document is in the cursor's output after skip/limit is
        // applied... but if they are false, then the document definitely is NOT
        // in the output. So it's safe to skip recompute if neither before or
        // after are true.)
        if (before || after) {
          recomputeQids[qid] = true;
        }
      } else if (before && !after) {
        LocalCollection._removeFromResults(query, doc);
      } else if (!before && after) {
        LocalCollection._insertInResults(query, doc);
      } else if (before && after) {
        LocalCollection._updateInResults(query, doc, old_doc);
      }
    });
  }

  // Recomputes the results of a query and runs observe callbacks for the
  // difference between the previous results and the current results (unless
  // paused). Used for skip/limit queries.
  //
  // When this is used by insert or remove, it can just use query.results for
  // the old results (and there's no need to pass in oldResults), because these
  // operations don't mutate the documents in the collection. Update needs to
  // pass in an oldResults which was deep-copied before the modifier was
  // applied.
  //
  // oldResults is guaranteed to be ignored if the query is not paused.
  _recomputeResults(query, oldResults) {
    if (this.paused) {
      // There's no reason to recompute the results now as we're still paused.
      // By flagging the query as "dirty", the recompute will be performed
      // when resumeObservers is called.
      query.dirty = true;
      return;
    }
    if (!this.paused && !oldResults) {
      oldResults = query.results;
    }
    if (query.distances) {
      query.distances.clear();
    }
    query.results = query.cursor._getRawObjects({
      distances: query.distances,
      ordered: query.ordered
    });
    if (!this.paused) {
      LocalCollection._diffQueryChanges(query.ordered, oldResults, query.results, query, {
        projectionFn: query.projectionFn
      });
    }
  }
  _saveOriginal(id, doc) {
    // Are we even trying to save originals?
    if (!this._savedOriginals) {
      return;
    }

    // Have we previously mutated the original (and so 'doc' is not actually
    // original)?  (Note the 'has' check rather than truth: we store undefined
    // here for inserted docs!)
    if (this._savedOriginals.has(id)) {
      return;
    }
    this._savedOriginals.set(id, EJSON.clone(doc));
  }
}
LocalCollection.Cursor = Cursor;
LocalCollection.ObserveHandle = ObserveHandle;

// XXX maybe move these into another ObserveHelpers package or something

// _CachingChangeObserver is an object which receives observeChanges callbacks
// and keeps a cache of the current cursor state up to date in this.docs. Users
// of this class should read the docs field but not modify it. You should pass
// the "applyChange" field as the callbacks to the underlying observeChanges
// call. Optionally, you can specify your own observeChanges callbacks which are
// invoked immediately before the docs field is updated; this object is made
// available as `this` to those callbacks.
LocalCollection._CachingChangeObserver = class _CachingChangeObserver {
  constructor() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    const orderedFromCallbacks = options.callbacks && LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);
    if (hasOwn.call(options, 'ordered')) {
      this.ordered = options.ordered;
      if (options.callbacks && options.ordered !== orderedFromCallbacks) {
        throw Error('ordered option doesn\'t match callbacks');
      }
    } else if (options.callbacks) {
      this.ordered = orderedFromCallbacks;
    } else {
      throw Error('must provide ordered or callbacks');
    }
    const callbacks = options.callbacks || {};
    if (this.ordered) {
      this.docs = new OrderedDict(MongoID.idStringify);
      this.applyChange = {
        addedBefore: (id, fields, before) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);
          doc._id = id;
          if (callbacks.addedBefore) {
            callbacks.addedBefore.call(this, id, EJSON.clone(fields), before);
          }

          // This line triggers if we provide added with movedBefore.
          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          }

          // XXX could `before` be a falsy ID?  Technically
          // idStringify seems to allow for them -- though
          // OrderedDict won't call stringify on a falsy arg.
          this.docs.putBefore(id, doc, before || null);
        },
        movedBefore: (id, before) => {
          const doc = this.docs.get(id);
          if (callbacks.movedBefore) {
            callbacks.movedBefore.call(this, id, before);
          }
          this.docs.moveBefore(id, before || null);
        }
      };
    } else {
      this.docs = new LocalCollection._IdMap();
      this.applyChange = {
        added: (id, fields) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);
          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          }
          doc._id = id;
          this.docs.set(id, doc);
        }
      };
    }

    // The methods in _IdMap and OrderedDict used by these callbacks are
    // identical.
    this.applyChange.changed = (id, fields) => {
      const doc = this.docs.get(id);
      if (!doc) {
        throw new Error("Unknown id for changed: ".concat(id));
      }
      if (callbacks.changed) {
        callbacks.changed.call(this, id, EJSON.clone(fields));
      }
      DiffSequence.applyChanges(doc, fields);
    };
    this.applyChange.removed = id => {
      if (callbacks.removed) {
        callbacks.removed.call(this, id);
      }
      this.docs.remove(id);
    };
  }
};
LocalCollection._IdMap = class _IdMap extends IdMap {
  constructor() {
    super(MongoID.idStringify, MongoID.idParse);
  }
};

// Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.
LocalCollection.wrapTransform = transform => {
  if (!transform) {
    return null;
  }

  // No need to doubly-wrap transforms.
  if (transform.__wrappedTransform__) {
    return transform;
  }
  const wrapped = doc => {
    if (!hasOwn.call(doc, '_id')) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error('can only transform documents with _id');
    }
    const id = doc._id;

    // XXX consider making tracker a weak dependency and checking
    // Package.tracker here
    const transformed = Tracker.nonreactive(() => transform(doc));
    if (!LocalCollection._isPlainObject(transformed)) {
      throw new Error('transform must return object');
    }
    if (hasOwn.call(transformed, '_id')) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error('transformed document can\'t have different _id');
      }
    } else {
      transformed._id = id;
    }
    return transformed;
  };
  wrapped.__wrappedTransform__ = true;
  return wrapped;
};

// XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.
//
// XXX the logic for observing with a skip or a limit is even more
// laughably inefficient. we recompute the whole results every time!

// This binary search puts a value between any equal values, and the first
// lesser value.
LocalCollection._binarySearch = (cmp, array, value) => {
  let first = 0;
  let range = array.length;
  while (range > 0) {
    const halfRange = Math.floor(range / 2);
    if (cmp(value, array[first + halfRange]) >= 0) {
      first += halfRange + 1;
      range -= halfRange + 1;
    } else {
      range = halfRange;
    }
  }
  return first;
};
LocalCollection._checkSupportedProjection = fields => {
  if (fields !== Object(fields) || Array.isArray(fields)) {
    throw MinimongoError('fields option must be an object');
  }
  Object.keys(fields).forEach(keyPath => {
    if (keyPath.split('.').includes('$')) {
      throw MinimongoError('Minimongo doesn\'t support $ operator in projections yet.');
    }
    const value = fields[keyPath];
    if (typeof value === 'object' && ['$elemMatch', '$meta', '$slice'].some(key => hasOwn.call(value, key))) {
      throw MinimongoError('Minimongo doesn\'t support operators in projections yet.');
    }
    if (![1, 0, true, false].includes(value)) {
      throw MinimongoError('Projection values should be one of 1, 0, true, or false');
    }
  });
};

// Knows how to compile a fields projection to a predicate function.
// @returns - Function: a closure that filters out an object according to the
//            fields projection rules:
//            @param obj - Object: MongoDB-styled document
//            @returns - Object: a document with the fields filtered out
//                       according to projection rules. Doesn't retain subfields
//                       of passed argument.
LocalCollection._compileProjection = fields => {
  LocalCollection._checkSupportedProjection(fields);
  const _idProjection = fields._id === undefined ? true : fields._id;
  const details = projectionDetails(fields);

  // returns transformed doc according to ruleTree
  const transform = (doc, ruleTree) => {
    // Special case for "sets"
    if (Array.isArray(doc)) {
      return doc.map(subdoc => transform(subdoc, ruleTree));
    }
    const result = details.including ? {} : EJSON.clone(doc);
    Object.keys(ruleTree).forEach(key => {
      if (doc == null || !hasOwn.call(doc, key)) {
        return;
      }
      const rule = ruleTree[key];
      if (rule === Object(rule)) {
        // For sub-objects/subsets we branch
        if (doc[key] === Object(doc[key])) {
          result[key] = transform(doc[key], rule);
        }
      } else if (details.including) {
        // Otherwise we don't even touch this subfield
        result[key] = EJSON.clone(doc[key]);
      } else {
        delete result[key];
      }
    });
    return doc != null ? result : doc;
  };
  return doc => {
    const result = transform(doc, details.tree);
    if (_idProjection && hasOwn.call(doc, '_id')) {
      result._id = doc._id;
    }
    if (!_idProjection && hasOwn.call(result, '_id')) {
      delete result._id;
    }
    return result;
  };
};

// Calculates the document to insert in case we're doing an upsert and the
// selector does not match any elements
LocalCollection._createUpsertDocument = (selector, modifier) => {
  const selectorDocument = populateDocumentWithQueryFields(selector);
  const isModify = LocalCollection._isModificationMod(modifier);
  const newDoc = {};
  if (selectorDocument._id) {
    newDoc._id = selectorDocument._id;
    delete selectorDocument._id;
  }

  // This double _modify call is made to help with nested properties (see issue
  // #8631). We do this even if it's a replacement for validation purposes (e.g.
  // ambiguous id's)
  LocalCollection._modify(newDoc, {
    $set: selectorDocument
  });
  LocalCollection._modify(newDoc, modifier, {
    isInsert: true
  });
  if (isModify) {
    return newDoc;
  }

  // Replacement can take _id from query document
  const replacement = Object.assign({}, modifier);
  if (newDoc._id) {
    replacement._id = newDoc._id;
  }
  return replacement;
};
LocalCollection._diffObjects = (left, right, callbacks) => {
  return DiffSequence.diffObjects(left, right, callbacks);
};

// ordered: bool.
// old_results and new_results: collections of documents.
//    if ordered, they are arrays.
//    if unordered, they are IdMaps
LocalCollection._diffQueryChanges = (ordered, oldResults, newResults, observer, options) => DiffSequence.diffQueryChanges(ordered, oldResults, newResults, observer, options);
LocalCollection._diffQueryOrderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryOrderedChanges(oldResults, newResults, observer, options);
LocalCollection._diffQueryUnorderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryUnorderedChanges(oldResults, newResults, observer, options);
LocalCollection._findInOrderedResults = (query, doc) => {
  if (!query.ordered) {
    throw new Error('Can\'t call _findInOrderedResults on unordered query');
  }
  for (let i = 0; i < query.results.length; i++) {
    if (query.results[i] === doc) {
      return i;
    }
  }
  throw Error('object missing from query');
};

// If this is a selector which explicitly constrains the match by ID to a finite
// number of documents, returns a list of their IDs.  Otherwise returns
// null. Note that the selector may have other restrictions so it may not even
// match those document!  We care about $in and $and since those are generated
// access-controlled update and remove.
LocalCollection._idsMatchedBySelector = selector => {
  // Is the selector just an ID?
  if (LocalCollection._selectorIsId(selector)) {
    return [selector];
  }
  if (!selector) {
    return null;
  }

  // Do we have an _id clause?
  if (hasOwn.call(selector, '_id')) {
    // Is the _id clause just an ID?
    if (LocalCollection._selectorIsId(selector._id)) {
      return [selector._id];
    }

    // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?
    if (selector._id && Array.isArray(selector._id.$in) && selector._id.$in.length && selector._id.$in.every(LocalCollection._selectorIsId)) {
      return selector._id.$in;
    }
    return null;
  }

  // If this is a top-level $and, and any of the clauses constrain their
  // documents, then the whole selector is constrained by any one clause's
  // constraint. (Well, by their intersection, but that seems unlikely.)
  if (Array.isArray(selector.$and)) {
    for (let i = 0; i < selector.$and.length; ++i) {
      const subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);
      if (subIds) {
        return subIds;
      }
    }
  }
  return null;
};
LocalCollection._insertInResults = (query, doc) => {
  const fields = EJSON.clone(doc);
  delete fields._id;
  if (query.ordered) {
    if (!query.sorter) {
      query.addedBefore(doc._id, query.projectionFn(fields), null);
      query.results.push(doc);
    } else {
      const i = LocalCollection._insertInSortedList(query.sorter.getComparator({
        distances: query.distances
      }), query.results, doc);
      let next = query.results[i + 1];
      if (next) {
        next = next._id;
      } else {
        next = null;
      }
      query.addedBefore(doc._id, query.projectionFn(fields), next);
    }
    query.added(doc._id, query.projectionFn(fields));
  } else {
    query.added(doc._id, query.projectionFn(fields));
    query.results.set(doc._id, doc);
  }
};
LocalCollection._insertInSortedList = (cmp, array, value) => {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }
  const i = LocalCollection._binarySearch(cmp, array, value);
  array.splice(i, 0, value);
  return i;
};
LocalCollection._isModificationMod = mod => {
  let isModify = false;
  let isReplace = false;
  Object.keys(mod).forEach(key => {
    if (key.substr(0, 1) === '$') {
      isModify = true;
    } else {
      isReplace = true;
    }
  });
  if (isModify && isReplace) {
    throw new Error('Update parameter cannot have both modifier and non-modifier fields.');
  }
  return isModify;
};

// XXX maybe this should be EJSON.isObject, though EJSON doesn't know about
// RegExp
// XXX note that _type(undefined) === 3!!!!
LocalCollection._isPlainObject = x => {
  return x && LocalCollection._f._type(x) === 3;
};

// XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.
LocalCollection._modify = function (doc, modifier) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  if (!LocalCollection._isPlainObject(modifier)) {
    throw MinimongoError('Modifier must be an object');
  }

  // Make sure the caller can't mutate our data structures.
  modifier = EJSON.clone(modifier);
  const isModifier = isOperatorObject(modifier);
  const newDoc = isModifier ? EJSON.clone(doc) : modifier;
  if (isModifier) {
    // apply modifiers to the doc.
    Object.keys(modifier).forEach(operator => {
      // Treat $setOnInsert as $set if this is an insert.
      const setOnInsert = options.isInsert && operator === '$setOnInsert';
      const modFunc = MODIFIERS[setOnInsert ? '$set' : operator];
      const operand = modifier[operator];
      if (!modFunc) {
        throw MinimongoError("Invalid modifier specified ".concat(operator));
      }
      Object.keys(operand).forEach(keypath => {
        const arg = operand[keypath];
        if (keypath === '') {
          throw MinimongoError('An empty update path is not valid.');
        }
        const keyparts = keypath.split('.');
        if (!keyparts.every(Boolean)) {
          throw MinimongoError("The update path '".concat(keypath, "' contains an empty field name, ") + 'which is not allowed.');
        }
        const target = findModTarget(newDoc, keyparts, {
          arrayIndices: options.arrayIndices,
          forbidArray: operator === '$rename',
          noCreate: NO_CREATE_MODIFIERS[operator]
        });
        modFunc(target, keyparts.pop(), arg, keypath, newDoc);
      });
    });
    if (doc._id && !EJSON.equals(doc._id, newDoc._id)) {
      throw MinimongoError("After applying the update to the document {_id: \"".concat(doc._id, "\", ...},") + ' the (immutable) field \'_id\' was found to have been altered to ' + "_id: \"".concat(newDoc._id, "\""));
    }
  } else {
    if (doc._id && modifier._id && !EJSON.equals(doc._id, modifier._id)) {
      throw MinimongoError("The _id field cannot be changed from {_id: \"".concat(doc._id, "\"} to ") + "{_id: \"".concat(modifier._id, "\"}"));
    }

    // replace the whole document
    assertHasValidFieldNames(modifier);
  }

  // move new document into place.
  Object.keys(doc).forEach(key => {
    // Note: this used to be for (var key in doc) however, this does not
    // work right in Opera. Deleting from a doc while iterating over it
    // would sometimes cause opera to skip some keys.
    if (key !== '_id') {
      delete doc[key];
    }
  });
  Object.keys(newDoc).forEach(key => {
    doc[key] = newDoc[key];
  });
};
LocalCollection._observeFromObserveChanges = (cursor, observeCallbacks) => {
  const transform = cursor.getTransform() || (doc => doc);
  let suppressed = !!observeCallbacks._suppress_initial;
  let observeChangesCallbacks;
  if (LocalCollection._observeCallbacksAreOrdered(observeCallbacks)) {
    // The "_no_indices" option sets all index arguments to -1 and skips the
    // linear scans required to generate them.  This lets observers that don't
    // need absolute indices benefit from the other features of this API --
    // relative order, transforms, and applyChanges -- without the speed hit.
    const indices = !observeCallbacks._no_indices;
    observeChangesCallbacks = {
      addedBefore(id, fields, before) {
        if (suppressed || !(observeCallbacks.addedAt || observeCallbacks.added)) {
          return;
        }
        const doc = transform(Object.assign(fields, {
          _id: id
        }));
        if (observeCallbacks.addedAt) {
          observeCallbacks.addedAt(doc, indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1, before);
        } else {
          observeCallbacks.added(doc);
        }
      },
      changed(id, fields) {
        if (!(observeCallbacks.changedAt || observeCallbacks.changed)) {
          return;
        }
        let doc = EJSON.clone(this.docs.get(id));
        if (!doc) {
          throw new Error("Unknown id for changed: ".concat(id));
        }
        const oldDoc = transform(EJSON.clone(doc));
        DiffSequence.applyChanges(doc, fields);
        if (observeCallbacks.changedAt) {
          observeCallbacks.changedAt(transform(doc), oldDoc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.changed(transform(doc), oldDoc);
        }
      },
      movedBefore(id, before) {
        if (!observeCallbacks.movedTo) {
          return;
        }
        const from = indices ? this.docs.indexOf(id) : -1;
        let to = indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1;

        // When not moving backwards, adjust for the fact that removing the
        // document slides everything back one slot.
        if (to > from) {
          --to;
        }
        observeCallbacks.movedTo(transform(EJSON.clone(this.docs.get(id))), from, to, before || null);
      },
      removed(id) {
        if (!(observeCallbacks.removedAt || observeCallbacks.removed)) {
          return;
        }

        // technically maybe there should be an EJSON.clone here, but it's about
        // to be removed from this.docs!
        const doc = transform(this.docs.get(id));
        if (observeCallbacks.removedAt) {
          observeCallbacks.removedAt(doc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.removed(doc);
        }
      }
    };
  } else {
    observeChangesCallbacks = {
      added(id, fields) {
        if (!suppressed && observeCallbacks.added) {
          observeCallbacks.added(transform(Object.assign(fields, {
            _id: id
          })));
        }
      },
      changed(id, fields) {
        if (observeCallbacks.changed) {
          const oldDoc = this.docs.get(id);
          const doc = EJSON.clone(oldDoc);
          DiffSequence.applyChanges(doc, fields);
          observeCallbacks.changed(transform(doc), transform(EJSON.clone(oldDoc)));
        }
      },
      removed(id) {
        if (observeCallbacks.removed) {
          observeCallbacks.removed(transform(this.docs.get(id)));
        }
      }
    };
  }
  const changeObserver = new LocalCollection._CachingChangeObserver({
    callbacks: observeChangesCallbacks
  });

  // CachingChangeObserver clones all received input on its callbacks
  // So we can mark it as safe to reduce the ejson clones.
  // This is tested by the `mongo-livedata - (extended) scribbling` tests
  changeObserver.applyChange._fromObserve = true;
  const handle = cursor.observeChanges(changeObserver.applyChange, {
    nonMutatingCallbacks: true
  });
  suppressed = false;
  return handle;
};
LocalCollection._observeCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedAt) {
    throw new Error('Please specify only one of added() and addedAt()');
  }
  if (callbacks.changed && callbacks.changedAt) {
    throw new Error('Please specify only one of changed() and changedAt()');
  }
  if (callbacks.removed && callbacks.removedAt) {
    throw new Error('Please specify only one of removed() and removedAt()');
  }
  return !!(callbacks.addedAt || callbacks.changedAt || callbacks.movedTo || callbacks.removedAt);
};
LocalCollection._observeChangesCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedBefore) {
    throw new Error('Please specify only one of added() and addedBefore()');
  }
  return !!(callbacks.addedBefore || callbacks.movedBefore);
};
LocalCollection._removeFromResults = (query, doc) => {
  if (query.ordered) {
    const i = LocalCollection._findInOrderedResults(query, doc);
    query.removed(doc._id);
    query.results.splice(i, 1);
  } else {
    const id = doc._id; // in case callback mutates doc

    query.removed(doc._id);
    query.results.remove(id);
  }
};

// Is this selector just shorthand for lookup by _id?
LocalCollection._selectorIsId = selector => typeof selector === 'number' || typeof selector === 'string' || selector instanceof MongoID.ObjectID;

// Is the selector just lookup by _id (shorthand or not)?
LocalCollection._selectorIsIdPerhapsAsObject = selector => LocalCollection._selectorIsId(selector) || LocalCollection._selectorIsId(selector && selector._id) && Object.keys(selector).length === 1;
LocalCollection._updateInResults = (query, doc, old_doc) => {
  if (!EJSON.equals(doc._id, old_doc._id)) {
    throw new Error('Can\'t change a doc\'s _id while updating');
  }
  const projectionFn = query.projectionFn;
  const changedFields = DiffSequence.makeChangedFields(projectionFn(doc), projectionFn(old_doc));
  if (!query.ordered) {
    if (Object.keys(changedFields).length) {
      query.changed(doc._id, changedFields);
      query.results.set(doc._id, doc);
    }
    return;
  }
  const old_idx = LocalCollection._findInOrderedResults(query, doc);
  if (Object.keys(changedFields).length) {
    query.changed(doc._id, changedFields);
  }
  if (!query.sorter) {
    return;
  }

  // just take it out and put it back in again, and see if the index changes
  query.results.splice(old_idx, 1);
  const new_idx = LocalCollection._insertInSortedList(query.sorter.getComparator({
    distances: query.distances
  }), query.results, doc);
  if (old_idx !== new_idx) {
    let next = query.results[new_idx + 1];
    if (next) {
      next = next._id;
    } else {
      next = null;
    }
    query.movedBefore && query.movedBefore(doc._id, next);
  }
};
const MODIFIERS = {
  $currentDate(target, field, arg) {
    if (typeof arg === 'object' && hasOwn.call(arg, '$type')) {
      if (arg.$type !== 'date') {
        throw MinimongoError('Minimongo does currently only support the date type in ' + '$currentDate modifiers', {
          field
        });
      }
    } else if (arg !== true) {
      throw MinimongoError('Invalid $currentDate modifier', {
        field
      });
    }
    target[field] = new Date();
  },
  $inc(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $inc allowed for numbers only', {
        field
      });
    }
    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $inc modifier to non-number', {
          field
        });
      }
      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },
  $min(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $min allowed for numbers only', {
        field
      });
    }
    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $min modifier to non-number', {
          field
        });
      }
      if (target[field] > arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },
  $max(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $max allowed for numbers only', {
        field
      });
    }
    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $max modifier to non-number', {
          field
        });
      }
      if (target[field] < arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },
  $mul(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $mul allowed for numbers only', {
        field
      });
    }
    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $mul modifier to non-number', {
          field
        });
      }
      target[field] *= arg;
    } else {
      target[field] = 0;
    }
  },
  $rename(target, field, arg, keypath, doc) {
    // no idea why mongo has this restriction..
    if (keypath === arg) {
      throw MinimongoError('$rename source must differ from target', {
        field
      });
    }
    if (target === null) {
      throw MinimongoError('$rename source field invalid', {
        field
      });
    }
    if (typeof arg !== 'string') {
      throw MinimongoError('$rename target must be a string', {
        field
      });
    }
    if (arg.includes('\0')) {
      // Null bytes are not allowed in Mongo field names
      // https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names
      throw MinimongoError('The \'to\' field for $rename cannot contain an embedded null byte', {
        field
      });
    }
    if (target === undefined) {
      return;
    }
    const object = target[field];
    delete target[field];
    const keyparts = arg.split('.');
    const target2 = findModTarget(doc, keyparts, {
      forbidArray: true
    });
    if (target2 === null) {
      throw MinimongoError('$rename target field invalid', {
        field
      });
    }
    target2[keyparts.pop()] = object;
  },
  $set(target, field, arg) {
    if (target !== Object(target)) {
      // not an array or an object
      const error = MinimongoError('Cannot set property on non-object field', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }
    if (target === null) {
      const error = MinimongoError('Cannot set property on null', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }
    assertHasValidFieldNames(arg);
    target[field] = arg;
  },
  $setOnInsert(target, field, arg) {
    // converted to `$set` in `_modify`
  },
  $unset(target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target) {
          target[field] = null;
        }
      } else {
        delete target[field];
      }
    }
  },
  $push(target, field, arg) {
    if (target[field] === undefined) {
      target[field] = [];
    }
    if (!(target[field] instanceof Array)) {
      throw MinimongoError('Cannot apply $push modifier to non-array', {
        field
      });
    }
    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      assertHasValidFieldNames(arg);
      target[field].push(arg);
      return;
    }

    // Fancy mode: $each (and maybe $slice and $sort and $position)
    const toPush = arg.$each;
    if (!(toPush instanceof Array)) {
      throw MinimongoError('$each must be an array', {
        field
      });
    }
    assertHasValidFieldNames(toPush);

    // Parse $position
    let position = undefined;
    if ('$position' in arg) {
      if (typeof arg.$position !== 'number') {
        throw MinimongoError('$position must be a numeric value', {
          field
        });
      }

      // XXX should check to make sure integer
      if (arg.$position < 0) {
        throw MinimongoError('$position in $push must be zero or positive', {
          field
        });
      }
      position = arg.$position;
    }

    // Parse $slice.
    let slice = undefined;
    if ('$slice' in arg) {
      if (typeof arg.$slice !== 'number') {
        throw MinimongoError('$slice must be a numeric value', {
          field
        });
      }

      // XXX should check to make sure integer
      slice = arg.$slice;
    }

    // Parse $sort.
    let sortFunction = undefined;
    if (arg.$sort) {
      if (slice === undefined) {
        throw MinimongoError('$sort requires $slice to be present', {
          field
        });
      }

      // XXX this allows us to use a $sort whose value is an array, but that's
      // actually an extension of the Node driver, so it won't work
      // server-side. Could be confusing!
      // XXX is it correct that we don't do geo-stuff here?
      sortFunction = new Minimongo.Sorter(arg.$sort).getComparator();
      toPush.forEach(element => {
        if (LocalCollection._f._type(element) !== 3) {
          throw MinimongoError('$push like modifiers using $sort require all elements to be ' + 'objects', {
            field
          });
        }
      });
    }

    // Actually push.
    if (position === undefined) {
      toPush.forEach(element => {
        target[field].push(element);
      });
    } else {
      const spliceArguments = [position, 0];
      toPush.forEach(element => {
        spliceArguments.push(element);
      });
      target[field].splice(...spliceArguments);
    }

    // Actually sort.
    if (sortFunction) {
      target[field].sort(sortFunction);
    }

    // Actually slice.
    if (slice !== undefined) {
      if (slice === 0) {
        target[field] = []; // differs from Array.slice!
      } else if (slice < 0) {
        target[field] = target[field].slice(slice);
      } else {
        target[field] = target[field].slice(0, slice);
      }
    }
  },
  $pushAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only');
    }
    assertHasValidFieldNames(arg);
    const toPush = target[field];
    if (toPush === undefined) {
      target[field] = arg;
    } else if (!(toPush instanceof Array)) {
      throw MinimongoError('Cannot apply $pushAll modifier to non-array', {
        field
      });
    } else {
      toPush.push(...arg);
    }
  },
  $addToSet(target, field, arg) {
    let isEach = false;
    if (typeof arg === 'object') {
      // check if first key is '$each'
      const keys = Object.keys(arg);
      if (keys[0] === '$each') {
        isEach = true;
      }
    }
    const values = isEach ? arg.$each : [arg];
    assertHasValidFieldNames(values);
    const toAdd = target[field];
    if (toAdd === undefined) {
      target[field] = values;
    } else if (!(toAdd instanceof Array)) {
      throw MinimongoError('Cannot apply $addToSet modifier to non-array', {
        field
      });
    } else {
      values.forEach(value => {
        if (toAdd.some(element => LocalCollection._f._equal(value, element))) {
          return;
        }
        toAdd.push(value);
      });
    }
  },
  $pop(target, field, arg) {
    if (target === undefined) {
      return;
    }
    const toPop = target[field];
    if (toPop === undefined) {
      return;
    }
    if (!(toPop instanceof Array)) {
      throw MinimongoError('Cannot apply $pop modifier to non-array', {
        field
      });
    }
    if (typeof arg === 'number' && arg < 0) {
      toPop.splice(0, 1);
    } else {
      toPop.pop();
    }
  },
  $pull(target, field, arg) {
    if (target === undefined) {
      return;
    }
    const toPull = target[field];
    if (toPull === undefined) {
      return;
    }
    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }
    let out;
    if (arg != null && typeof arg === 'object' && !(arg instanceof Array)) {
      // XXX would be much nicer to compile this once, rather than
      // for each document we modify.. but usually we're not
      // modifying that many documents, so we'll let it slide for
      // now

      // XXX Minimongo.Matcher isn't up for the job, because we need
      // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
      // like {$gt: 4} is not normally a complete selector.
      // same issue as $elemMatch possibly?
      const matcher = new Minimongo.Matcher(arg);
      out = toPull.filter(element => !matcher.documentMatches(element).result);
    } else {
      out = toPull.filter(element => !LocalCollection._f._equal(element, arg));
    }
    target[field] = out;
  },
  $pullAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only', {
        field
      });
    }
    if (target === undefined) {
      return;
    }
    const toPull = target[field];
    if (toPull === undefined) {
      return;
    }
    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }
    target[field] = toPull.filter(object => !arg.some(element => LocalCollection._f._equal(object, element)));
  },
  $bit(target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw MinimongoError('$bit is not supported', {
      field
    });
  },
  $v() {
    // As discussed in https://github.com/meteor/meteor/issues/9623,
    // the `$v` operator is not needed by Meteor, but problems can occur if
    // it's not at least callable (as of Mongo >= 3.6). It's defined here as
    // a no-op to work around these problems.
  }
};
const NO_CREATE_MODIFIERS = {
  $pop: true,
  $pull: true,
  $pullAll: true,
  $rename: true,
  $unset: true
};

// Make sure field names do not contain Mongo restricted
// characters ('.', '$', '\0').
// https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names
const invalidCharMsg = {
  $: 'start with \'$\'',
  '.': 'contain \'.\'',
  '\0': 'contain null bytes'
};

// checks if all field names in an object are valid
function assertHasValidFieldNames(doc) {
  if (doc && typeof doc === 'object') {
    JSON.stringify(doc, (key, value) => {
      assertIsValidFieldName(key);
      return value;
    });
  }
}
function assertIsValidFieldName(key) {
  let match;
  if (typeof key === 'string' && (match = key.match(/^\$|\.|\0/))) {
    throw MinimongoError("Key ".concat(key, " must not ").concat(invalidCharMsg[match[0]]));
  }
}

// for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndices is set, use its first element for the (first) '$' in
// the path.
function findModTarget(doc, keyparts) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  let usedArrayIndex = false;
  for (let i = 0; i < keyparts.length; i++) {
    const last = i === keyparts.length - 1;
    let keypart = keyparts[i];
    if (!isIndexable(doc)) {
      if (options.noCreate) {
        return undefined;
      }
      const error = MinimongoError("cannot use the part '".concat(keypart, "' to traverse ").concat(doc));
      error.setPropertyError = true;
      throw error;
    }
    if (doc instanceof Array) {
      if (options.forbidArray) {
        return null;
      }
      if (keypart === '$') {
        if (usedArrayIndex) {
          throw MinimongoError('Too many positional (i.e. \'$\') elements');
        }
        if (!options.arrayIndices || !options.arrayIndices.length) {
          throw MinimongoError('The positional operator did not find the match needed from the ' + 'query');
        }
        keypart = options.arrayIndices[0];
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate) {
          return undefined;
        }
        throw MinimongoError("can't append to array using string field name [".concat(keypart, "]"));
      }
      if (last) {
        keyparts[i] = keypart; // handle 'a.01'
      }

      if (options.noCreate && keypart >= doc.length) {
        return undefined;
      }
      while (doc.length < keypart) {
        doc.push(null);
      }
      if (!last) {
        if (doc.length === keypart) {
          doc.push({});
        } else if (typeof doc[keypart] !== 'object') {
          throw MinimongoError("can't modify field '".concat(keyparts[i + 1], "' of list value ") + JSON.stringify(doc[keypart]));
        }
      }
    } else {
      assertIsValidFieldName(keypart);
      if (!(keypart in doc)) {
        if (options.noCreate) {
          return undefined;
        }
        if (!last) {
          doc[keypart] = {};
        }
      }
    }
    if (last) {
      return doc;
    }
    doc = doc[keypart];
  }

  // notreached
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"matcher.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/matcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var _Package$mongoDecima;
module.export({
  default: () => Matcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }
}, 0);
let compileDocumentSelector, hasOwn, nothingMatcher;
module.link("./common.js", {
  compileDocumentSelector(v) {
    compileDocumentSelector = v;
  },
  hasOwn(v) {
    hasOwn = v;
  },
  nothingMatcher(v) {
    nothingMatcher = v;
  }
}, 1);
const Decimal = ((_Package$mongoDecima = Package['mongo-decimal']) === null || _Package$mongoDecima === void 0 ? void 0 : _Package$mongoDecima.Decimal) || class DecimalStub {};

// The minimongo selector compiler!

// Terminology:
//  - a 'selector' is the EJSON object representing a selector
//  - a 'matcher' is its compiled form (whether a full Minimongo.Matcher
//    object or one of the component lambdas that matches parts of it)
//  - a 'result object' is an object with a 'result' field and maybe
//    distance and arrayIndices.
//  - a 'branched value' is an object with a 'value' field and maybe
//    'dontIterate' and 'arrayIndices'.
//  - a 'document' is a top-level object that can be stored in a collection.
//  - a 'lookup function' is a function that takes in a document and returns
//    an array of 'branched values'.
//  - a 'branched matcher' maps from an array of branched values to a result
//    object.
//  - an 'element matcher' maps from a single value to a bool.

// Main entry point.
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});
//   if (matcher.documentMatches({a: 7})) ...
class Matcher {
  constructor(selector, isUpdate) {
    // A set (object mapping string -> *) of all of the document paths looked
    // at by the selector. Also includes the empty string if it may look at any
    // path (eg, $where).
    this._paths = {};
    // Set to true if compilation finds a $near.
    this._hasGeoQuery = false;
    // Set to true if compilation finds a $where.
    this._hasWhere = false;
    // Set to false if compilation finds anything other than a simple equality
    // or one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used
    // with scalars as operands.
    this._isSimple = true;
    // Set to a dummy document which always matches this Matcher. Or set to null
    // if such document is too hard to find.
    this._matchingDocument = undefined;
    // A clone of the original selector. It may just be a function if the user
    // passed in a function; otherwise is definitely an object (eg, IDs are
    // translated into {_id: ID} first. Used by canBecomeTrueByModifier and
    // Sorter._useWithMatcher.
    this._selector = null;
    this._docMatcher = this._compileSelector(selector);
    // Set to true if selection is done for an update operation
    // Default is false
    // Used for $near array update (issue #3599)
    this._isUpdate = isUpdate;
  }
  documentMatches(doc) {
    if (doc !== Object(doc)) {
      throw Error('documentMatches needs a document');
    }
    return this._docMatcher(doc);
  }
  hasGeoQuery() {
    return this._hasGeoQuery;
  }
  hasWhere() {
    return this._hasWhere;
  }
  isSimple() {
    return this._isSimple;
  }

  // Given a selector, return a function that takes one argument, a
  // document. It returns a result object.
  _compileSelector(selector) {
    // you can pass a literal function instead of a selector
    if (selector instanceof Function) {
      this._isSimple = false;
      this._selector = selector;
      this._recordPathUsed('');
      return doc => ({
        result: !!selector.call(doc)
      });
    }

    // shorthand -- scalar _id
    if (LocalCollection._selectorIsId(selector)) {
      this._selector = {
        _id: selector
      };
      this._recordPathUsed('_id');
      return doc => ({
        result: EJSON.equals(doc._id, selector)
      });
    }

    // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for
    // destructive operations.
    if (!selector || hasOwn.call(selector, '_id') && !selector._id) {
      this._isSimple = false;
      return nothingMatcher;
    }

    // Top level can't be an array or true or binary.
    if (Array.isArray(selector) || EJSON.isBinary(selector) || typeof selector === 'boolean') {
      throw new Error("Invalid selector: ".concat(selector));
    }
    this._selector = EJSON.clone(selector);
    return compileDocumentSelector(selector, this, {
      isRoot: true
    });
  }

  // Returns a list of key paths the given selector is looking for. It includes
  // the empty string if there is a $where.
  _getPaths() {
    return Object.keys(this._paths);
  }
  _recordPathUsed(path) {
    this._paths[path] = true;
  }
}
// helpers used by compiled selector code
LocalCollection._f = {
  // XXX for _all and _in, consider building 'inquery' at compile time..
  _type(v) {
    if (typeof v === 'number') {
      return 1;
    }
    if (typeof v === 'string') {
      return 2;
    }
    if (typeof v === 'boolean') {
      return 8;
    }
    if (Array.isArray(v)) {
      return 4;
    }
    if (v === null) {
      return 10;
    }

    // note that typeof(/x/) === "object"
    if (v instanceof RegExp) {
      return 11;
    }
    if (typeof v === 'function') {
      return 13;
    }
    if (v instanceof Date) {
      return 9;
    }
    if (EJSON.isBinary(v)) {
      return 5;
    }
    if (v instanceof MongoID.ObjectID) {
      return 7;
    }
    if (v instanceof Decimal) {
      return 1;
    }

    // object
    return 3;

    // XXX support some/all of these:
    // 14, symbol
    // 15, javascript code with scope
    // 16, 18: 32-bit/64-bit integer
    // 17, timestamp
    // 255, minkey
    // 127, maxkey
  },

  // deep equality test: use for literal document and array matches
  _equal(a, b) {
    return EJSON.equals(a, b, {
      keyOrderSensitive: true
    });
  },
  // maps a type code to a value that can be used to sort values of different
  // types
  _typeorder(t) {
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types
    // XXX what is the correct sort position for Javascript code?
    // ('100' in the matrix below)
    // XXX minkey/maxkey
    return [-1,
    // (not a type)
    1,
    // number
    2,
    // string
    3,
    // object
    4,
    // array
    5,
    // binary
    -1,
    // deprecated
    6,
    // ObjectID
    7,
    // bool
    8,
    // Date
    0,
    // null
    9,
    // RegExp
    -1,
    // deprecated
    100,
    // JS code
    2,
    // deprecated (symbol)
    100,
    // JS code
    1,
    // 32-bit int
    8,
    // Mongo timestamp
    1 // 64-bit int
    ][t];
  },
  // compare two values of unknown type according to BSON ordering
  // semantics. (as an extension, consider 'undefined' to be less than
  // any other value.) return negative if a is less, positive if b is
  // less, or 0 if equal
  _cmp(a, b) {
    if (a === undefined) {
      return b === undefined ? 0 : -1;
    }
    if (b === undefined) {
      return 1;
    }
    let ta = LocalCollection._f._type(a);
    let tb = LocalCollection._f._type(b);
    const oa = LocalCollection._f._typeorder(ta);
    const ob = LocalCollection._f._typeorder(tb);
    if (oa !== ob) {
      return oa < ob ? -1 : 1;
    }

    // XXX need to implement this if we implement Symbol or integers, or
    // Timestamp
    if (ta !== tb) {
      throw Error('Missing type coercion logic in _cmp');
    }
    if (ta === 7) {
      // ObjectID
      // Convert to string.
      ta = tb = 2;
      a = a.toHexString();
      b = b.toHexString();
    }
    if (ta === 9) {
      // Date
      // Convert to millis.
      ta = tb = 1;
      a = isNaN(a) ? 0 : a.getTime();
      b = isNaN(b) ? 0 : b.getTime();
    }
    if (ta === 1) {
      // double
      if (a instanceof Decimal) {
        return a.minus(b).toNumber();
      } else {
        return a - b;
      }
    }
    if (tb === 2)
      // string
      return a < b ? -1 : a === b ? 0 : 1;
    if (ta === 3) {
      // Object
      // this could be much more efficient in the expected case ...
      const toArray = object => {
        const result = [];
        Object.keys(object).forEach(key => {
          result.push(key, object[key]);
        });
        return result;
      };
      return LocalCollection._f._cmp(toArray(a), toArray(b));
    }
    if (ta === 4) {
      // Array
      for (let i = 0;; i++) {
        if (i === a.length) {
          return i === b.length ? 0 : -1;
        }
        if (i === b.length) {
          return 1;
        }
        const s = LocalCollection._f._cmp(a[i], b[i]);
        if (s !== 0) {
          return s;
        }
      }
    }
    if (ta === 5) {
      // binary
      // Surprisingly, a small binary blob is always less than a large one in
      // Mongo.
      if (a.length !== b.length) {
        return a.length - b.length;
      }
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) {
          return -1;
        }
        if (a[i] > b[i]) {
          return 1;
        }
      }
      return 0;
    }
    if (ta === 8) {
      // boolean
      if (a) {
        return b ? 0 : 1;
      }
      return b ? -1 : 0;
    }
    if (ta === 10)
      // null
      return 0;
    if (ta === 11)
      // regexp
      throw Error('Sorting not supported on regular expression'); // XXX

    // 13: javascript code
    // 14: symbol
    // 15: javascript code with scope
    // 16: 32-bit integer
    // 17: timestamp
    // 18: 64-bit integer
    // 255: minkey
    // 127: maxkey
    if (ta === 13)
      // javascript code
      throw Error('Sorting not supported on Javascript code'); // XXX

    throw Error('Unknown type to sort');
  }
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"minimongo_common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_common.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let LocalCollection_;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection_ = v;
  }
}, 0);
let Matcher;
module.link("./matcher.js", {
  default(v) {
    Matcher = v;
  }
}, 1);
let Sorter;
module.link("./sorter.js", {
  default(v) {
    Sorter = v;
  }
}, 2);
LocalCollection = LocalCollection_;
Minimongo = {
  LocalCollection: LocalCollection_,
  Matcher,
  Sorter
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_handle.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/observe_handle.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => ObserveHandle
});
class ObserveHandle {}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"sorter.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/sorter.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Sorter
});
let ELEMENT_OPERATORS, equalityElementMatcher, expandArraysInBranches, hasOwn, isOperatorObject, makeLookupFunction, regexpElementMatcher;
module.link("./common.js", {
  ELEMENT_OPERATORS(v) {
    ELEMENT_OPERATORS = v;
  },
  equalityElementMatcher(v) {
    equalityElementMatcher = v;
  },
  expandArraysInBranches(v) {
    expandArraysInBranches = v;
  },
  hasOwn(v) {
    hasOwn = v;
  },
  isOperatorObject(v) {
    isOperatorObject = v;
  },
  makeLookupFunction(v) {
    makeLookupFunction = v;
  },
  regexpElementMatcher(v) {
    regexpElementMatcher = v;
  }
}, 0);
class Sorter {
  constructor(spec) {
    this._sortSpecParts = [];
    this._sortFunction = null;
    const addSpecPart = (path, ascending) => {
      if (!path) {
        throw Error('sort keys must be non-empty');
      }
      if (path.charAt(0) === '$') {
        throw Error("unsupported sort key: ".concat(path));
      }
      this._sortSpecParts.push({
        ascending,
        lookup: makeLookupFunction(path, {
          forSort: true
        }),
        path
      });
    };
    if (spec instanceof Array) {
      spec.forEach(element => {
        if (typeof element === 'string') {
          addSpecPart(element, true);
        } else {
          addSpecPart(element[0], element[1] !== 'desc');
        }
      });
    } else if (typeof spec === 'object') {
      Object.keys(spec).forEach(key => {
        addSpecPart(key, spec[key] >= 0);
      });
    } else if (typeof spec === 'function') {
      this._sortFunction = spec;
    } else {
      throw Error("Bad sort specification: ".concat(JSON.stringify(spec)));
    }

    // If a function is specified for sorting, we skip the rest.
    if (this._sortFunction) {
      return;
    }

    // To implement affectedByModifier, we piggy-back on top of Matcher's
    // affectedByModifier code; we create a selector that is affected by the
    // same modifiers as this sort order. This is only implemented on the
    // server.
    if (this.affectedByModifier) {
      const selector = {};
      this._sortSpecParts.forEach(spec => {
        selector[spec.path] = 1;
      });
      this._selectorForAffectedByModifier = new Minimongo.Matcher(selector);
    }
    this._keyComparator = composeComparators(this._sortSpecParts.map((spec, i) => this._keyFieldComparator(i)));
  }
  getComparator(options) {
    // If sort is specified or have no distances, just use the comparator from
    // the source specification (which defaults to "everything is equal".
    // issue #3599
    // https://docs.mongodb.com/manual/reference/operator/query/near/#sort-operation
    // sort effectively overrides $near
    if (this._sortSpecParts.length || !options || !options.distances) {
      return this._getBaseComparator();
    }
    const distances = options.distances;

    // Return a comparator which compares using $near distances.
    return (a, b) => {
      if (!distances.has(a._id)) {
        throw Error("Missing distance for ".concat(a._id));
      }
      if (!distances.has(b._id)) {
        throw Error("Missing distance for ".concat(b._id));
      }
      return distances.get(a._id) - distances.get(b._id);
    };
  }

  // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.
  _compareKeys(key1, key2) {
    if (key1.length !== this._sortSpecParts.length || key2.length !== this._sortSpecParts.length) {
      throw Error('Key has wrong length');
    }
    return this._keyComparator(key1, key2);
  }

  // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.
  _generateKeysFromDoc(doc, cb) {
    if (this._sortSpecParts.length === 0) {
      throw new Error('can\'t generate keys without a spec');
    }
    const pathFromIndices = indices => "".concat(indices.join(','), ",");
    let knownPaths = null;

    // maps index -> ({'' -> value} or {path -> value})
    const valuesByIndexAndPath = this._sortSpecParts.map(spec => {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      let branches = expandArraysInBranches(spec.lookup(doc), true);

      // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one undefined value.
      if (!branches.length) {
        branches = [{
          value: void 0
        }];
      }
      const element = Object.create(null);
      let usedPaths = false;
      branches.forEach(branch => {
        if (!branch.arrayIndices) {
          // If there are no array indices for a branch, then it must be the
          // only branch, because the only thing that produces multiple branches
          // is the use of arrays.
          if (branches.length > 1) {
            throw Error('multiple branches but no array used?');
          }
          element[''] = branch.value;
          return;
        }
        usedPaths = true;
        const path = pathFromIndices(branch.arrayIndices);
        if (hasOwn.call(element, path)) {
          throw Error("duplicate path: ".concat(path));
        }
        element[path] = branch.value;

        // If two sort fields both go into arrays, they have to go into the
        // exact same arrays and we have to find the same paths.  This is
        // roughly the same condition that makes MongoDB throw this strange
        // error message.  eg, the main thing is that if sort spec is {a: 1,
        // b:1} then a and b cannot both be arrays.
        //
        // (In MongoDB it seems to be OK to have {a: 1, 'a.x.y': 1} where 'a'
        // and 'a.x.y' are both arrays, but we don't allow this for now.
        // #NestedArraySort
        // XXX achieve full compatibility here
        if (knownPaths && !hasOwn.call(knownPaths, path)) {
          throw Error('cannot index parallel arrays');
        }
      });
      if (knownPaths) {
        // Similarly to above, paths must match everywhere, unless this is a
        // non-array field.
        if (!hasOwn.call(element, '') && Object.keys(knownPaths).length !== Object.keys(element).length) {
          throw Error('cannot index parallel arrays!');
        }
      } else if (usedPaths) {
        knownPaths = {};
        Object.keys(element).forEach(path => {
          knownPaths[path] = true;
        });
      }
      return element;
    });
    if (!knownPaths) {
      // Easy case: no use of arrays.
      const soleKey = valuesByIndexAndPath.map(values => {
        if (!hasOwn.call(values, '')) {
          throw Error('no value in sole key case?');
        }
        return values[''];
      });
      cb(soleKey);
      return;
    }
    Object.keys(knownPaths).forEach(path => {
      const key = valuesByIndexAndPath.map(values => {
        if (hasOwn.call(values, '')) {
          return values[''];
        }
        if (!hasOwn.call(values, path)) {
          throw Error('missing path?');
        }
        return values[path];
      });
      cb(key);
    });
  }

  // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).
  _getBaseComparator() {
    if (this._sortFunction) {
      return this._sortFunction;
    }

    // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.
    if (!this._sortSpecParts.length) {
      return (doc1, doc2) => 0;
    }
    return (doc1, doc2) => {
      const key1 = this._getMinKeyFromDoc(doc1);
      const key2 = this._getMinKeyFromDoc(doc2);
      return this._compareKeys(key1, key2);
    };
  }

  // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.
  _getMinKeyFromDoc(doc) {
    let minKey = null;
    this._generateKeysFromDoc(doc, key => {
      if (minKey === null) {
        minKey = key;
        return;
      }
      if (this._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });
    return minKey;
  }
  _getPaths() {
    return this._sortSpecParts.map(part => part.path);
  }

  // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.
  _keyFieldComparator(i) {
    const invert = !this._sortSpecParts[i].ascending;
    return (key1, key2) => {
      const compare = LocalCollection._f._cmp(key1[i], key2[i]);
      return invert ? -compare : compare;
    };
  }
}
// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
function composeComparators(comparatorArray) {
  return (a, b) => {
    for (let i = 0; i < comparatorArray.length; ++i) {
      const compare = comparatorArray[i](a, b);
      if (compare !== 0) {
        return compare;
      }
    }
    return 0;
  };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

var exports = require("/node_modules/meteor/minimongo/minimongo_server.js");

/* Exports */
Package._define("minimongo", exports, {
  LocalCollection: LocalCollection,
  Minimongo: Minimongo,
  MinimongoTest: MinimongoTest,
  MinimongoError: MinimongoError
});

})();

//# sourceURL=meteor://💻app/packages/minimongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19zZXJ2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jb25zdGFudHMuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jdXJzb3IuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9sb2NhbF9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9taW5pbW9uZ28vbWF0Y2hlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9vYnNlcnZlX2hhbmRsZS5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL3NvcnRlci5qcyJdLCJuYW1lcyI6WyJtb2R1bGUiLCJsaW5rIiwiaGFzT3duIiwiaXNOdW1lcmljS2V5IiwiaXNPcGVyYXRvck9iamVjdCIsInBhdGhzVG9UcmVlIiwicHJvamVjdGlvbkRldGFpbHMiLCJ2IiwiTWluaW1vbmdvIiwiX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzIiwicGF0aHMiLCJtYXAiLCJwYXRoIiwic3BsaXQiLCJmaWx0ZXIiLCJwYXJ0Iiwiam9pbiIsIk1hdGNoZXIiLCJwcm90b3R5cGUiLCJhZmZlY3RlZEJ5TW9kaWZpZXIiLCJtb2RpZmllciIsIk9iamVjdCIsImFzc2lnbiIsIiRzZXQiLCIkdW5zZXQiLCJtZWFuaW5nZnVsUGF0aHMiLCJfZ2V0UGF0aHMiLCJtb2RpZmllZFBhdGhzIiwiY29uY2F0Iiwia2V5cyIsInNvbWUiLCJtb2QiLCJtZWFuaW5nZnVsUGF0aCIsInNlbCIsImkiLCJqIiwibGVuZ3RoIiwiY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIiLCJpc1NpbXBsZSIsIm1vZGlmaWVyUGF0aHMiLCJwYXRoSGFzTnVtZXJpY0tleXMiLCJleHBlY3RlZFNjYWxhcklzT2JqZWN0IiwiX3NlbGVjdG9yIiwibW9kaWZpZXJQYXRoIiwic3RhcnRzV2l0aCIsIm1hdGNoaW5nRG9jdW1lbnQiLCJFSlNPTiIsImNsb25lIiwiTG9jYWxDb2xsZWN0aW9uIiwiX21vZGlmeSIsImVycm9yIiwibmFtZSIsInNldFByb3BlcnR5RXJyb3IiLCJkb2N1bWVudE1hdGNoZXMiLCJyZXN1bHQiLCJjb21iaW5lSW50b1Byb2plY3Rpb24iLCJwcm9qZWN0aW9uIiwic2VsZWN0b3JQYXRocyIsImluY2x1ZGVzIiwiY29tYmluZUltcG9ydGFudFBhdGhzSW50b1Byb2plY3Rpb24iLCJfbWF0Y2hpbmdEb2N1bWVudCIsInVuZGVmaW5lZCIsImZhbGxiYWNrIiwidmFsdWVTZWxlY3RvciIsIiRlcSIsIiRpbiIsIm1hdGNoZXIiLCJwbGFjZWhvbGRlciIsImZpbmQiLCJvbmx5Q29udGFpbnNLZXlzIiwibG93ZXJCb3VuZCIsIkluZmluaXR5IiwidXBwZXJCb3VuZCIsImZvckVhY2giLCJvcCIsImNhbGwiLCJtaWRkbGUiLCJ4IiwiU29ydGVyIiwiX3NlbGVjdG9yRm9yQWZmZWN0ZWRCeU1vZGlmaWVyIiwiZGV0YWlscyIsInRyZWUiLCJub2RlIiwiZnVsbFBhdGgiLCJtZXJnZWRQcm9qZWN0aW9uIiwidHJlZVRvUGF0aHMiLCJpbmNsdWRpbmciLCJtZXJnZWRFeGNsUHJvamVjdGlvbiIsImdldFBhdGhzIiwic2VsZWN0b3IiLCJfcGF0aHMiLCJvYmoiLCJldmVyeSIsImsiLCJwcmVmaXgiLCJrZXkiLCJ2YWx1ZSIsImV4cG9ydCIsIkVMRU1FTlRfT1BFUkFUT1JTIiwiY29tcGlsZURvY3VtZW50U2VsZWN0b3IiLCJlcXVhbGl0eUVsZW1lbnRNYXRjaGVyIiwiZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyIsImlzSW5kZXhhYmxlIiwibWFrZUxvb2t1cEZ1bmN0aW9uIiwibm90aGluZ01hdGNoZXIiLCJwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzIiwicmVnZXhwRWxlbWVudE1hdGNoZXIiLCJkZWZhdWx0IiwiaGFzT3duUHJvcGVydHkiLCIkbHQiLCJtYWtlSW5lcXVhbGl0eSIsImNtcFZhbHVlIiwiJGd0IiwiJGx0ZSIsIiRndGUiLCIkbW9kIiwiY29tcGlsZUVsZW1lbnRTZWxlY3RvciIsIm9wZXJhbmQiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImRpdmlzb3IiLCJyZW1haW5kZXIiLCJlbGVtZW50TWF0Y2hlcnMiLCJvcHRpb24iLCJSZWdFeHAiLCIkc2l6ZSIsImRvbnRFeHBhbmRMZWFmQXJyYXlzIiwiJHR5cGUiLCJkb250SW5jbHVkZUxlYWZBcnJheXMiLCJvcGVyYW5kQWxpYXNNYXAiLCJfZiIsIl90eXBlIiwiJGJpdHNBbGxTZXQiLCJtYXNrIiwiZ2V0T3BlcmFuZEJpdG1hc2siLCJiaXRtYXNrIiwiZ2V0VmFsdWVCaXRtYXNrIiwiYnl0ZSIsIiRiaXRzQW55U2V0IiwiJGJpdHNBbGxDbGVhciIsIiRiaXRzQW55Q2xlYXIiLCIkcmVnZXgiLCJyZWdleHAiLCIkb3B0aW9ucyIsInRlc3QiLCJzb3VyY2UiLCIkZWxlbU1hdGNoIiwiX2lzUGxhaW5PYmplY3QiLCJpc0RvY01hdGNoZXIiLCJMT0dJQ0FMX09QRVJBVE9SUyIsInJlZHVjZSIsImEiLCJiIiwic3ViTWF0Y2hlciIsImluRWxlbU1hdGNoIiwiY29tcGlsZVZhbHVlU2VsZWN0b3IiLCJhcnJheUVsZW1lbnQiLCJhcmciLCJkb250SXRlcmF0ZSIsIiRhbmQiLCJzdWJTZWxlY3RvciIsImFuZERvY3VtZW50TWF0Y2hlcnMiLCJjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzIiwiJG9yIiwibWF0Y2hlcnMiLCJkb2MiLCJmbiIsIiRub3IiLCIkd2hlcmUiLCJzZWxlY3RvclZhbHVlIiwiX3JlY29yZFBhdGhVc2VkIiwiX2hhc1doZXJlIiwiRnVuY3Rpb24iLCIkY29tbWVudCIsIlZBTFVFX09QRVJBVE9SUyIsImNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyIiwiJG5vdCIsImludmVydEJyYW5jaGVkTWF0Y2hlciIsIiRuZSIsIiRuaW4iLCIkZXhpc3RzIiwiZXhpc3RzIiwiZXZlcnl0aGluZ01hdGNoZXIiLCIkbWF4RGlzdGFuY2UiLCIkbmVhciIsIiRhbGwiLCJicmFuY2hlZE1hdGNoZXJzIiwiY3JpdGVyaW9uIiwiYW5kQnJhbmNoZWRNYXRjaGVycyIsImlzUm9vdCIsIl9oYXNHZW9RdWVyeSIsIm1heERpc3RhbmNlIiwicG9pbnQiLCJkaXN0YW5jZSIsIiRnZW9tZXRyeSIsInR5cGUiLCJHZW9KU09OIiwicG9pbnREaXN0YW5jZSIsImNvb3JkaW5hdGVzIiwicG9pbnRUb0FycmF5IiwiZ2VvbWV0cnlXaXRoaW5SYWRpdXMiLCJkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyIsImJyYW5jaGVkVmFsdWVzIiwiYnJhbmNoIiwiY3VyRGlzdGFuY2UiLCJfaXNVcGRhdGUiLCJhcnJheUluZGljZXMiLCJhbmRTb21lTWF0Y2hlcnMiLCJzdWJNYXRjaGVycyIsImRvY09yQnJhbmNoZXMiLCJtYXRjaCIsInN1YlJlc3VsdCIsInNlbGVjdG9ycyIsImRvY1NlbGVjdG9yIiwib3B0aW9ucyIsImRvY01hdGNoZXJzIiwic3Vic3RyIiwiX2lzU2ltcGxlIiwibG9va1VwQnlJbmRleCIsInZhbHVlTWF0Y2hlciIsIkJvb2xlYW4iLCJvcGVyYXRvckJyYW5jaGVkTWF0Y2hlciIsImVsZW1lbnRNYXRjaGVyIiwiYnJhbmNoZXMiLCJleHBhbmRlZCIsImVsZW1lbnQiLCJtYXRjaGVkIiwicG9pbnRBIiwicG9pbnRCIiwiTWF0aCIsImh5cG90IiwiZWxlbWVudFNlbGVjdG9yIiwiX2VxdWFsIiwiZG9jT3JCcmFuY2hlZFZhbHVlcyIsInNraXBUaGVBcnJheXMiLCJicmFuY2hlc091dCIsInRoaXNJc0FycmF5IiwicHVzaCIsIk51bWJlciIsImlzSW50ZWdlciIsIlVpbnQ4QXJyYXkiLCJJbnQzMkFycmF5IiwiYnVmZmVyIiwiaXNCaW5hcnkiLCJBcnJheUJ1ZmZlciIsIm1heCIsInZpZXciLCJpc1NhZmVJbnRlZ2VyIiwiVWludDMyQXJyYXkiLCJCWVRFU19QRVJfRUxFTUVOVCIsImluc2VydEludG9Eb2N1bWVudCIsImRvY3VtZW50IiwiZXhpc3RpbmdLZXkiLCJpbmRleE9mIiwiYnJhbmNoZWRNYXRjaGVyIiwiYnJhbmNoVmFsdWVzIiwicyIsImluY29uc2lzdGVudE9LIiwidGhlc2VBcmVPcGVyYXRvcnMiLCJzZWxLZXkiLCJ0aGlzSXNPcGVyYXRvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJjbXBWYWx1ZUNvbXBhcmF0b3IiLCJvcGVyYW5kVHlwZSIsIl9jbXAiLCJwYXJ0cyIsImZpcnN0UGFydCIsImxvb2t1cFJlc3QiLCJzbGljZSIsImJ1aWxkUmVzdWx0IiwiZmlyc3RMZXZlbCIsImFwcGVuZFRvUmVzdWx0IiwibW9yZSIsImZvclNvcnQiLCJhcnJheUluZGV4IiwiTWluaW1vbmdvVGVzdCIsIk1pbmltb25nb0Vycm9yIiwibWVzc2FnZSIsImZpZWxkIiwib3BlcmF0b3JNYXRjaGVycyIsIm9wZXJhdG9yIiwic2ltcGxlUmFuZ2UiLCJzaW1wbGVFcXVhbGl0eSIsInNpbXBsZUluY2x1c2lvbiIsIm5ld0xlYWZGbiIsImNvbmZsaWN0Rm4iLCJyb290IiwicGF0aEFycmF5Iiwic3VjY2VzcyIsImxhc3RLZXkiLCJ5IiwicG9wdWxhdGVEb2N1bWVudFdpdGhLZXlWYWx1ZSIsImdldFByb3RvdHlwZU9mIiwicG9wdWxhdGVEb2N1bWVudFdpdGhPYmplY3QiLCJ1bnByZWZpeGVkS2V5cyIsInZhbGlkYXRlT2JqZWN0Iiwib2JqZWN0IiwicXVlcnkiLCJfc2VsZWN0b3JJc0lkIiwiZmllbGRzIiwiZmllbGRzS2V5cyIsInNvcnQiLCJfaWQiLCJrZXlQYXRoIiwicnVsZSIsInByb2plY3Rpb25SdWxlc1RyZWUiLCJjdXJyZW50UGF0aCIsImFub3RoZXJQYXRoIiwidG9TdHJpbmciLCJsYXN0SW5kZXgiLCJ2YWxpZGF0ZUtleUluUGF0aCIsImdldEFzeW5jTWV0aG9kTmFtZSIsIkFTWU5DX0NPTExFQ1RJT05fTUVUSE9EUyIsIkFTWU5DX0NVUlNPUl9NRVRIT0RTIiwibWV0aG9kIiwicmVwbGFjZSIsIkN1cnNvciIsImNvbnN0cnVjdG9yIiwiY29sbGVjdGlvbiIsInNvcnRlciIsIl9zZWxlY3RvcklzSWRQZXJoYXBzQXNPYmplY3QiLCJfc2VsZWN0b3JJZCIsImhhc0dlb1F1ZXJ5Iiwic2tpcCIsImxpbWl0IiwiX3Byb2plY3Rpb25GbiIsIl9jb21waWxlUHJvamVjdGlvbiIsIl90cmFuc2Zvcm0iLCJ3cmFwVHJhbnNmb3JtIiwidHJhbnNmb3JtIiwiVHJhY2tlciIsInJlYWN0aXZlIiwiY291bnQiLCJfZGVwZW5kIiwiYWRkZWQiLCJyZW1vdmVkIiwiX2dldFJhd09iamVjdHMiLCJvcmRlcmVkIiwiZmV0Y2giLCJTeW1ib2wiLCJpdGVyYXRvciIsImFkZGVkQmVmb3JlIiwiY2hhbmdlZCIsIm1vdmVkQmVmb3JlIiwiaW5kZXgiLCJvYmplY3RzIiwibmV4dCIsImRvbmUiLCJhc3luY0l0ZXJhdG9yIiwic3luY1Jlc3VsdCIsIlByb21pc2UiLCJyZXNvbHZlIiwiY2FsbGJhY2siLCJ0aGlzQXJnIiwiZ2V0VHJhbnNmb3JtIiwib2JzZXJ2ZSIsIl9vYnNlcnZlRnJvbU9ic2VydmVDaGFuZ2VzIiwib2JzZXJ2ZUNoYW5nZXMiLCJfb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkIiwiX2FsbG93X3Vub3JkZXJlZCIsImRpc3RhbmNlcyIsIl9JZE1hcCIsImN1cnNvciIsImRpcnR5IiwicHJvamVjdGlvbkZuIiwicmVzdWx0c1NuYXBzaG90IiwicWlkIiwibmV4dF9xaWQiLCJxdWVyaWVzIiwicmVzdWx0cyIsInBhdXNlZCIsIndyYXBDYWxsYmFjayIsInNlbGYiLCJhcmdzIiwiYXJndW1lbnRzIiwiX29ic2VydmVRdWV1ZSIsInF1ZXVlVGFzayIsImFwcGx5IiwiX3N1cHByZXNzX2luaXRpYWwiLCJoYW5kbGUiLCJPYnNlcnZlSGFuZGxlIiwic3RvcCIsImFjdGl2ZSIsIm9uSW52YWxpZGF0ZSIsImRyYWluIiwiY2hhbmdlcnMiLCJkZXBlbmRlbmN5IiwiRGVwZW5kZW5jeSIsIm5vdGlmeSIsImJpbmQiLCJkZXBlbmQiLCJfZ2V0Q29sbGVjdGlvbk5hbWUiLCJhcHBseVNraXBMaW1pdCIsInNlbGVjdGVkRG9jIiwiX2RvY3MiLCJnZXQiLCJzZXQiLCJjbGVhciIsImlkIiwibWF0Y2hSZXN1bHQiLCJnZXRDb21wYXJhdG9yIiwiX3B1Ymxpc2hDdXJzb3IiLCJzdWJzY3JpcHRpb24iLCJQYWNrYWdlIiwibW9uZ28iLCJNb25nbyIsIkNvbGxlY3Rpb24iLCJhc3luY05hbWUiLCJyZWplY3QiLCJfb2JqZWN0U3ByZWFkIiwiTWV0ZW9yIiwiX1N5bmNocm9ub3VzUXVldWUiLCJjcmVhdGUiLCJfc2F2ZWRPcmlnaW5hbHMiLCJjb3VudERvY3VtZW50cyIsImNvdW50QXN5bmMiLCJlc3RpbWF0ZWREb2N1bWVudENvdW50IiwiZmluZE9uZSIsImluc2VydCIsImFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyIsIl91c2VPSUQiLCJNb25nb0lEIiwiT2JqZWN0SUQiLCJSYW5kb20iLCJoYXMiLCJfc2F2ZU9yaWdpbmFsIiwicXVlcmllc1RvUmVjb21wdXRlIiwiX2luc2VydEluUmVzdWx0cyIsIl9yZWNvbXB1dGVSZXN1bHRzIiwiZGVmZXIiLCJwYXVzZU9ic2VydmVycyIsInJlbW92ZSIsImVxdWFscyIsInNpemUiLCJfZWFjaFBvc3NpYmx5TWF0Y2hpbmdEb2MiLCJxdWVyeVJlbW92ZSIsInJlbW92ZUlkIiwicmVtb3ZlRG9jIiwiX3JlbW92ZUZyb21SZXN1bHRzIiwicmVzdW1lT2JzZXJ2ZXJzIiwiX2RpZmZRdWVyeUNoYW5nZXMiLCJyZXRyaWV2ZU9yaWdpbmFscyIsIm9yaWdpbmFscyIsInNhdmVPcmlnaW5hbHMiLCJ1cGRhdGUiLCJxaWRUb09yaWdpbmFsUmVzdWx0cyIsImRvY01hcCIsImlkc01hdGNoZWQiLCJfaWRzTWF0Y2hlZEJ5U2VsZWN0b3IiLCJtZW1vaXplZENsb25lSWZOZWVkZWQiLCJkb2NUb01lbW9pemUiLCJyZWNvbXB1dGVRaWRzIiwidXBkYXRlQ291bnQiLCJxdWVyeVJlc3VsdCIsIl9tb2RpZnlBbmROb3RpZnkiLCJtdWx0aSIsImluc2VydGVkSWQiLCJ1cHNlcnQiLCJfY3JlYXRlVXBzZXJ0RG9jdW1lbnQiLCJfcmV0dXJuT2JqZWN0IiwibnVtYmVyQWZmZWN0ZWQiLCJzcGVjaWZpY0lkcyIsIm1hdGNoZWRfYmVmb3JlIiwib2xkX2RvYyIsImFmdGVyTWF0Y2giLCJhZnRlciIsImJlZm9yZSIsIl91cGRhdGVJblJlc3VsdHMiLCJvbGRSZXN1bHRzIiwiX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciIsIm9yZGVyZWRGcm9tQ2FsbGJhY2tzIiwiY2FsbGJhY2tzIiwiZG9jcyIsIk9yZGVyZWREaWN0IiwiaWRTdHJpbmdpZnkiLCJhcHBseUNoYW5nZSIsInB1dEJlZm9yZSIsIm1vdmVCZWZvcmUiLCJEaWZmU2VxdWVuY2UiLCJhcHBseUNoYW5nZXMiLCJJZE1hcCIsImlkUGFyc2UiLCJfX3dyYXBwZWRUcmFuc2Zvcm1fXyIsIndyYXBwZWQiLCJ0cmFuc2Zvcm1lZCIsIm5vbnJlYWN0aXZlIiwiX2JpbmFyeVNlYXJjaCIsImNtcCIsImFycmF5IiwiZmlyc3QiLCJyYW5nZSIsImhhbGZSYW5nZSIsImZsb29yIiwiX2NoZWNrU3VwcG9ydGVkUHJvamVjdGlvbiIsIl9pZFByb2plY3Rpb24iLCJydWxlVHJlZSIsInN1YmRvYyIsInNlbGVjdG9yRG9jdW1lbnQiLCJpc01vZGlmeSIsIl9pc01vZGlmaWNhdGlvbk1vZCIsIm5ld0RvYyIsImlzSW5zZXJ0IiwicmVwbGFjZW1lbnQiLCJfZGlmZk9iamVjdHMiLCJsZWZ0IiwicmlnaHQiLCJkaWZmT2JqZWN0cyIsIm5ld1Jlc3VsdHMiLCJvYnNlcnZlciIsImRpZmZRdWVyeUNoYW5nZXMiLCJfZGlmZlF1ZXJ5T3JkZXJlZENoYW5nZXMiLCJkaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyIsIl9kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzIiwiZGlmZlF1ZXJ5VW5vcmRlcmVkQ2hhbmdlcyIsIl9maW5kSW5PcmRlcmVkUmVzdWx0cyIsInN1YklkcyIsIl9pbnNlcnRJblNvcnRlZExpc3QiLCJzcGxpY2UiLCJpc1JlcGxhY2UiLCJpc01vZGlmaWVyIiwic2V0T25JbnNlcnQiLCJtb2RGdW5jIiwiTU9ESUZJRVJTIiwia2V5cGF0aCIsImtleXBhcnRzIiwidGFyZ2V0IiwiZmluZE1vZFRhcmdldCIsImZvcmJpZEFycmF5Iiwibm9DcmVhdGUiLCJOT19DUkVBVEVfTU9ESUZJRVJTIiwicG9wIiwib2JzZXJ2ZUNhbGxiYWNrcyIsInN1cHByZXNzZWQiLCJvYnNlcnZlQ2hhbmdlc0NhbGxiYWNrcyIsIl9vYnNlcnZlQ2FsbGJhY2tzQXJlT3JkZXJlZCIsImluZGljZXMiLCJfbm9faW5kaWNlcyIsImFkZGVkQXQiLCJjaGFuZ2VkQXQiLCJvbGREb2MiLCJtb3ZlZFRvIiwiZnJvbSIsInRvIiwicmVtb3ZlZEF0IiwiY2hhbmdlT2JzZXJ2ZXIiLCJfZnJvbU9ic2VydmUiLCJub25NdXRhdGluZ0NhbGxiYWNrcyIsImNoYW5nZWRGaWVsZHMiLCJtYWtlQ2hhbmdlZEZpZWxkcyIsIm9sZF9pZHgiLCJuZXdfaWR4IiwiJGN1cnJlbnREYXRlIiwiRGF0ZSIsIiRpbmMiLCIkbWluIiwiJG1heCIsIiRtdWwiLCIkcmVuYW1lIiwidGFyZ2V0MiIsIiRzZXRPbkluc2VydCIsIiRwdXNoIiwiJGVhY2giLCJ0b1B1c2giLCJwb3NpdGlvbiIsIiRwb3NpdGlvbiIsIiRzbGljZSIsInNvcnRGdW5jdGlvbiIsIiRzb3J0Iiwic3BsaWNlQXJndW1lbnRzIiwiJHB1c2hBbGwiLCIkYWRkVG9TZXQiLCJpc0VhY2giLCJ2YWx1ZXMiLCJ0b0FkZCIsIiRwb3AiLCJ0b1BvcCIsIiRwdWxsIiwidG9QdWxsIiwib3V0IiwiJHB1bGxBbGwiLCIkYml0IiwiJHYiLCJpbnZhbGlkQ2hhck1zZyIsIiQiLCJhc3NlcnRJc1ZhbGlkRmllbGROYW1lIiwidXNlZEFycmF5SW5kZXgiLCJsYXN0Iiwia2V5cGFydCIsInBhcnNlSW50IiwiRGVjaW1hbCIsIkRlY2ltYWxTdHViIiwiaXNVcGRhdGUiLCJfZG9jTWF0Y2hlciIsIl9jb21waWxlU2VsZWN0b3IiLCJoYXNXaGVyZSIsImtleU9yZGVyU2Vuc2l0aXZlIiwiX3R5cGVvcmRlciIsInQiLCJ0YSIsInRiIiwib2EiLCJvYiIsInRvSGV4U3RyaW5nIiwiaXNOYU4iLCJnZXRUaW1lIiwibWludXMiLCJ0b051bWJlciIsInRvQXJyYXkiLCJMb2NhbENvbGxlY3Rpb25fIiwic3BlYyIsIl9zb3J0U3BlY1BhcnRzIiwiX3NvcnRGdW5jdGlvbiIsImFkZFNwZWNQYXJ0IiwiYXNjZW5kaW5nIiwiY2hhckF0IiwibG9va3VwIiwiX2tleUNvbXBhcmF0b3IiLCJjb21wb3NlQ29tcGFyYXRvcnMiLCJfa2V5RmllbGRDb21wYXJhdG9yIiwiX2dldEJhc2VDb21wYXJhdG9yIiwiX2NvbXBhcmVLZXlzIiwia2V5MSIsImtleTIiLCJfZ2VuZXJhdGVLZXlzRnJvbURvYyIsImNiIiwicGF0aEZyb21JbmRpY2VzIiwia25vd25QYXRocyIsInZhbHVlc0J5SW5kZXhBbmRQYXRoIiwidXNlZFBhdGhzIiwic29sZUtleSIsImRvYzEiLCJkb2MyIiwiX2dldE1pbktleUZyb21Eb2MiLCJtaW5LZXkiLCJpbnZlcnQiLCJjb21wYXJlIiwiY29tcGFyYXRvckFycmF5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUFBLE1BQU0sQ0FBQ0MsSUFBSSxDQUFDLHVCQUF1QixDQUFDO0FBQUMsSUFBSUMsTUFBTSxFQUFDQyxZQUFZLEVBQUNDLGdCQUFnQixFQUFDQyxXQUFXLEVBQUNDLGlCQUFpQjtBQUFDTixNQUFNLENBQUNDLElBQUksQ0FBQyxhQUFhLEVBQUM7RUFBQ0MsTUFBTSxDQUFDSyxDQUFDLEVBQUM7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T0FBTyxHQUFHQyxlQUFlLENBQUM1bEIsQ0FBQyxDQUFDLENBQUNzSCxDQUFDLEVBQUVDLENBQUMsQ0FBQztNQUN4QyxJQUFJb2UsT0FBTyxLQUFLLENBQUMsRUFBRTtRQUNqQixPQUFPQSxPQUFPO01BQ2hCO0lBQ0Y7SUFFQSxPQUFPLENBQUM7RUFDVixDQUFDO0FBQ0gsQyIsImZpbGUiOiIvcGFja2FnZXMvbWluaW1vbmdvLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICcuL21pbmltb25nb19jb21tb24uanMnO1xuaW1wb3J0IHtcbiAgaGFzT3duLFxuICBpc051bWVyaWNLZXksXG4gIGlzT3BlcmF0b3JPYmplY3QsXG4gIHBhdGhzVG9UcmVlLFxuICBwcm9qZWN0aW9uRGV0YWlscyxcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG5NaW5pbW9uZ28uX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzID0gcGF0aHMgPT4gcGF0aHMubWFwKHBhdGggPT5cbiAgcGF0aC5zcGxpdCgnLicpLmZpbHRlcihwYXJ0ID0+ICFpc051bWVyaWNLZXkocGFydCkpLmpvaW4oJy4nKVxuKTtcblxuLy8gUmV0dXJucyB0cnVlIGlmIHRoZSBtb2RpZmllciBhcHBsaWVkIHRvIHNvbWUgZG9jdW1lbnQgbWF5IGNoYW5nZSB0aGUgcmVzdWx0XG4vLyBvZiBtYXRjaGluZyB0aGUgZG9jdW1lbnQgYnkgc2VsZWN0b3Jcbi8vIFRoZSBtb2RpZmllciBpcyBhbHdheXMgaW4gYSBmb3JtIG9mIE9iamVjdDpcbi8vICAtICRzZXRcbi8vICAgIC0gJ2EuYi4yMi56JzogdmFsdWVcbi8vICAgIC0gJ2Zvby5iYXInOiA0MlxuLy8gIC0gJHVuc2V0XG4vLyAgICAtICdhYmMuZCc6IDFcbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5hZmZlY3RlZEJ5TW9kaWZpZXIgPSBmdW5jdGlvbihtb2RpZmllcikge1xuICAvLyBzYWZlIGNoZWNrIGZvciAkc2V0LyR1bnNldCBiZWluZyBvYmplY3RzXG4gIG1vZGlmaWVyID0gT2JqZWN0LmFzc2lnbih7JHNldDoge30sICR1bnNldDoge319LCBtb2RpZmllcik7XG5cbiAgY29uc3QgbWVhbmluZ2Z1bFBhdGhzID0gdGhpcy5fZ2V0UGF0aHMoKTtcbiAgY29uc3QgbW9kaWZpZWRQYXRocyA9IFtdLmNvbmNhdChcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kc2V0KSxcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kdW5zZXQpXG4gICk7XG5cbiAgcmV0dXJuIG1vZGlmaWVkUGF0aHMuc29tZShwYXRoID0+IHtcbiAgICBjb25zdCBtb2QgPSBwYXRoLnNwbGl0KCcuJyk7XG5cbiAgICByZXR1cm4gbWVhbmluZ2Z1bFBhdGhzLnNvbWUobWVhbmluZ2Z1bFBhdGggPT4ge1xuICAgICAgY29uc3Qgc2VsID0gbWVhbmluZ2Z1bFBhdGguc3BsaXQoJy4nKTtcblxuICAgICAgbGV0IGkgPSAwLCBqID0gMDtcblxuICAgICAgd2hpbGUgKGkgPCBzZWwubGVuZ3RoICYmIGogPCBtb2QubGVuZ3RoKSB7XG4gICAgICAgIGlmIChpc051bWVyaWNLZXkoc2VsW2ldKSAmJiBpc051bWVyaWNLZXkobW9kW2pdKSkge1xuICAgICAgICAgIC8vIGZvby40LmJhciBzZWxlY3RvciBhZmZlY3RlZCBieSBmb28uNCBtb2RpZmllclxuICAgICAgICAgIC8vIGZvby4zLmJhciBzZWxlY3RvciB1bmFmZmVjdGVkIGJ5IGZvby40IG1vZGlmaWVyXG4gICAgICAgICAgaWYgKHNlbFtpXSA9PT0gbW9kW2pdKSB7XG4gICAgICAgICAgICBpKys7XG4gICAgICAgICAgICBqKys7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoaXNOdW1lcmljS2V5KHNlbFtpXSkpIHtcbiAgICAgICAgICAvLyBmb28uNC5iYXIgc2VsZWN0b3IgdW5hZmZlY3RlZCBieSBmb28uYmFyIG1vZGlmaWVyXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9IGVsc2UgaWYgKGlzTnVtZXJpY0tleShtb2Rbal0pKSB7XG4gICAgICAgICAgaisrO1xuICAgICAgICB9IGVsc2UgaWYgKHNlbFtpXSA9PT0gbW9kW2pdKSB7XG4gICAgICAgICAgaSsrO1xuICAgICAgICAgIGorKztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gT25lIGlzIGEgcHJlZml4IG9mIGFub3RoZXIsIHRha2luZyBudW1lcmljIGZpZWxkcyBpbnRvIGFjY291bnRcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbi8vIEBwYXJhbSBtb2RpZmllciAtIE9iamVjdDogTW9uZ29EQi1zdHlsZWQgbW9kaWZpZXIgd2l0aCBgJHNldGBzIGFuZCBgJHVuc2V0c2Bcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgb25seS4gKGFzc3VtZWQgdG8gY29tZSBmcm9tIG9wbG9nKVxuLy8gQHJldHVybnMgLSBCb29sZWFuOiBpZiBhZnRlciBhcHBseWluZyB0aGUgbW9kaWZpZXIsIHNlbGVjdG9yIGNhbiBzdGFydFxuLy8gICAgICAgICAgICAgICAgICAgICBhY2NlcHRpbmcgdGhlIG1vZGlmaWVkIHZhbHVlLlxuLy8gTk9URTogYXNzdW1lcyB0aGF0IGRvY3VtZW50IGFmZmVjdGVkIGJ5IG1vZGlmaWVyIGRpZG4ndCBtYXRjaCB0aGlzIE1hdGNoZXJcbi8vIGJlZm9yZSwgc28gaWYgbW9kaWZpZXIgY2FuJ3QgY29udmluY2Ugc2VsZWN0b3IgaW4gYSBwb3NpdGl2ZSBjaGFuZ2UgaXQgd291bGRcbi8vIHN0YXkgJ2ZhbHNlJy5cbi8vIEN1cnJlbnRseSBkb2Vzbid0IHN1cHBvcnQgJC1vcGVyYXRvcnMgYW5kIG51bWVyaWMgaW5kaWNlcyBwcmVjaXNlbHkuXG5NaW5pbW9uZ28uTWF0Y2hlci5wcm90b3R5cGUuY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIgPSBmdW5jdGlvbihtb2RpZmllcikge1xuICBpZiAoIXRoaXMuYWZmZWN0ZWRCeU1vZGlmaWVyKG1vZGlmaWVyKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmICghdGhpcy5pc1NpbXBsZSgpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBtb2RpZmllciA9IE9iamVjdC5hc3NpZ24oeyRzZXQ6IHt9LCAkdW5zZXQ6IHt9fSwgbW9kaWZpZXIpO1xuXG4gIGNvbnN0IG1vZGlmaWVyUGF0aHMgPSBbXS5jb25jYXQoXG4gICAgT2JqZWN0LmtleXMobW9kaWZpZXIuJHNldCksXG4gICAgT2JqZWN0LmtleXMobW9kaWZpZXIuJHVuc2V0KVxuICApO1xuXG4gIGlmICh0aGlzLl9nZXRQYXRocygpLnNvbWUocGF0aEhhc051bWVyaWNLZXlzKSB8fFxuICAgICAgbW9kaWZpZXJQYXRocy5zb21lKHBhdGhIYXNOdW1lcmljS2V5cykpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIGNoZWNrIGlmIHRoZXJlIGlzIGEgJHNldCBvciAkdW5zZXQgdGhhdCBpbmRpY2F0ZXMgc29tZXRoaW5nIGlzIGFuXG4gIC8vIG9iamVjdCByYXRoZXIgdGhhbiBhIHNjYWxhciBpbiB0aGUgYWN0dWFsIG9iamVjdCB3aGVyZSB3ZSBzYXcgJC1vcGVyYXRvclxuICAvLyBOT1RFOiBpdCBpcyBjb3JyZWN0IHNpbmNlIHdlIGFsbG93IG9ubHkgc2NhbGFycyBpbiAkLW9wZXJhdG9yc1xuICAvLyBFeGFtcGxlOiBmb3Igc2VsZWN0b3IgeydhLmInOiB7JGd0OiA1fX0gdGhlIG1vZGlmaWVyIHsnYS5iLmMnOjd9IHdvdWxkXG4gIC8vIGRlZmluaXRlbHkgc2V0IHRoZSByZXN1bHQgdG8gZmFsc2UgYXMgJ2EuYicgYXBwZWFycyB0byBiZSBhbiBvYmplY3QuXG4gIGNvbnN0IGV4cGVjdGVkU2NhbGFySXNPYmplY3QgPSBPYmplY3Qua2V5cyh0aGlzLl9zZWxlY3Rvcikuc29tZShwYXRoID0+IHtcbiAgICBpZiAoIWlzT3BlcmF0b3JPYmplY3QodGhpcy5fc2VsZWN0b3JbcGF0aF0pKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuIG1vZGlmaWVyUGF0aHMuc29tZShtb2RpZmllclBhdGggPT5cbiAgICAgIG1vZGlmaWVyUGF0aC5zdGFydHNXaXRoKGAke3BhdGh9LmApXG4gICAgKTtcbiAgfSk7XG5cbiAgaWYgKGV4cGVjdGVkU2NhbGFySXNPYmplY3QpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBTZWUgaWYgd2UgY2FuIGFwcGx5IHRoZSBtb2RpZmllciBvbiB0aGUgaWRlYWxseSBtYXRjaGluZyBvYmplY3QuIElmIGl0XG4gIC8vIHN0aWxsIG1hdGNoZXMgdGhlIHNlbGVjdG9yLCB0aGVuIHRoZSBtb2RpZmllciBjb3VsZCBoYXZlIHR1cm5lZCB0aGUgcmVhbFxuICAvLyBvYmplY3QgaW4gdGhlIGRhdGFiYXNlIGludG8gc29tZXRoaW5nIG1hdGNoaW5nLlxuICBjb25zdCBtYXRjaGluZ0RvY3VtZW50ID0gRUpTT04uY2xvbmUodGhpcy5tYXRjaGluZ0RvY3VtZW50KCkpO1xuXG4gIC8vIFRoZSBzZWxlY3RvciBpcyB0b28gY29tcGxleCwgYW55dGhpbmcgY2FuIGhhcHBlbi5cbiAgaWYgKG1hdGNoaW5nRG9jdW1lbnQgPT09IG51bGwpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobWF0Y2hpbmdEb2N1bWVudCwgbW9kaWZpZXIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIENvdWxkbid0IHNldCBhIHByb3BlcnR5IG9uIGEgZmllbGQgd2hpY2ggaXMgYSBzY2FsYXIgb3IgbnVsbCBpbiB0aGVcbiAgICAvLyBzZWxlY3Rvci5cbiAgICAvLyBFeGFtcGxlOlxuICAgIC8vIHJlYWwgZG9jdW1lbnQ6IHsgJ2EuYic6IDMgfVxuICAgIC8vIHNlbGVjdG9yOiB7ICdhJzogMTIgfVxuICAgIC8vIGNvbnZlcnRlZCBzZWxlY3RvciAoaWRlYWwgZG9jdW1lbnQpOiB7ICdhJzogMTIgfVxuICAgIC8vIG1vZGlmaWVyOiB7ICRzZXQ6IHsgJ2EuYic6IDQgfSB9XG4gICAgLy8gV2UgZG9uJ3Qga25vdyB3aGF0IHJlYWwgZG9jdW1lbnQgd2FzIGxpa2UgYnV0IGZyb20gdGhlIGVycm9yIHJhaXNlZCBieVxuICAgIC8vICRzZXQgb24gYSBzY2FsYXIgZmllbGQgd2UgY2FuIHJlYXNvbiB0aGF0IHRoZSBzdHJ1Y3R1cmUgb2YgcmVhbCBkb2N1bWVudFxuICAgIC8vIGlzIGNvbXBsZXRlbHkgZGlmZmVyZW50LlxuICAgIGlmIChlcnJvci5uYW1lID09PSAnTWluaW1vbmdvRXJyb3InICYmIGVycm9yLnNldFByb3BlcnR5RXJyb3IpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIHJldHVybiB0aGlzLmRvY3VtZW50TWF0Y2hlcyhtYXRjaGluZ0RvY3VtZW50KS5yZXN1bHQ7XG59O1xuXG4vLyBLbm93cyBob3cgdG8gY29tYmluZSBhIG1vbmdvIHNlbGVjdG9yIGFuZCBhIGZpZWxkcyBwcm9qZWN0aW9uIHRvIGEgbmV3IGZpZWxkc1xuLy8gcHJvamVjdGlvbiB0YWtpbmcgaW50byBhY2NvdW50IGFjdGl2ZSBmaWVsZHMgZnJvbSB0aGUgcGFzc2VkIHNlbGVjdG9yLlxuLy8gQHJldHVybnMgT2JqZWN0IC0gcHJvamVjdGlvbiBvYmplY3QgKHNhbWUgYXMgZmllbGRzIG9wdGlvbiBvZiBtb25nbyBjdXJzb3IpXG5NaW5pbW9uZ28uTWF0Y2hlci5wcm90b3R5cGUuY29tYmluZUludG9Qcm9qZWN0aW9uID0gZnVuY3Rpb24ocHJvamVjdGlvbikge1xuICBjb25zdCBzZWxlY3RvclBhdGhzID0gTWluaW1vbmdvLl9wYXRoc0VsaWRpbmdOdW1lcmljS2V5cyh0aGlzLl9nZXRQYXRocygpKTtcblxuICAvLyBTcGVjaWFsIGNhc2UgZm9yICR3aGVyZSBvcGVyYXRvciBpbiB0aGUgc2VsZWN0b3IgLSBwcm9qZWN0aW9uIHNob3VsZCBkZXBlbmRcbiAgLy8gb24gYWxsIGZpZWxkcyBvZiB0aGUgZG9jdW1lbnQuIGdldFNlbGVjdG9yUGF0aHMgcmV0dXJucyBhIGxpc3Qgb2YgcGF0aHNcbiAgLy8gc2VsZWN0b3IgZGVwZW5kcyBvbi4gSWYgb25lIG9mIHRoZSBwYXRocyBpcyAnJyAoZW1wdHkgc3RyaW5nKSByZXByZXNlbnRpbmdcbiAgLy8gdGhlIHJvb3Qgb3IgdGhlIHdob2xlIGRvY3VtZW50LCBjb21wbGV0ZSBwcm9qZWN0aW9uIHNob3VsZCBiZSByZXR1cm5lZC5cbiAgaWYgKHNlbGVjdG9yUGF0aHMuaW5jbHVkZXMoJycpKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgcmV0dXJuIGNvbWJpbmVJbXBvcnRhbnRQYXRoc0ludG9Qcm9qZWN0aW9uKHNlbGVjdG9yUGF0aHMsIHByb2plY3Rpb24pO1xufTtcblxuLy8gUmV0dXJucyBhbiBvYmplY3QgdGhhdCB3b3VsZCBtYXRjaCB0aGUgc2VsZWN0b3IgaWYgcG9zc2libGUgb3IgbnVsbCBpZiB0aGVcbi8vIHNlbGVjdG9yIGlzIHRvbyBjb21wbGV4IGZvciB1cyB0byBhbmFseXplXG4vLyB7ICdhLmInOiB7IGFuczogNDIgfSwgJ2Zvby5iYXInOiBudWxsLCAnZm9vLmJheic6IFwic29tZXRoaW5nXCIgfVxuLy8gPT4geyBhOiB7IGI6IHsgYW5zOiA0MiB9IH0sIGZvbzogeyBiYXI6IG51bGwsIGJhejogXCJzb21ldGhpbmdcIiB9IH1cbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5tYXRjaGluZ0RvY3VtZW50ID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIGlmIGl0IHdhcyBjb21wdXRlZCBiZWZvcmVcbiAgaWYgKHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB0aGlzLl9tYXRjaGluZ0RvY3VtZW50O1xuICB9XG5cbiAgLy8gSWYgdGhlIGFuYWx5c2lzIG9mIHRoaXMgc2VsZWN0b3IgaXMgdG9vIGhhcmQgZm9yIG91ciBpbXBsZW1lbnRhdGlvblxuICAvLyBmYWxsYmFjayB0byBcIllFU1wiXG4gIGxldCBmYWxsYmFjayA9IGZhbHNlO1xuXG4gIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSBwYXRoc1RvVHJlZShcbiAgICB0aGlzLl9nZXRQYXRocygpLFxuICAgIHBhdGggPT4ge1xuICAgICAgY29uc3QgdmFsdWVTZWxlY3RvciA9IHRoaXMuX3NlbGVjdG9yW3BhdGhdO1xuXG4gICAgICBpZiAoaXNPcGVyYXRvck9iamVjdCh2YWx1ZVNlbGVjdG9yKSkge1xuICAgICAgICAvLyBpZiB0aGVyZSBpcyBhIHN0cmljdCBlcXVhbGl0eSwgdGhlcmUgaXMgYSBnb29kXG4gICAgICAgIC8vIGNoYW5jZSB3ZSBjYW4gdXNlIG9uZSBvZiB0aG9zZSBhcyBcIm1hdGNoaW5nXCJcbiAgICAgICAgLy8gZHVtbXkgdmFsdWVcbiAgICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJGVxKSB7XG4gICAgICAgICAgcmV0dXJuIHZhbHVlU2VsZWN0b3IuJGVxO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJGluKSB7XG4gICAgICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcih7cGxhY2Vob2xkZXI6IHZhbHVlU2VsZWN0b3J9KTtcblxuICAgICAgICAgIC8vIFJldHVybiBhbnl0aGluZyBmcm9tICRpbiB0aGF0IG1hdGNoZXMgdGhlIHdob2xlIHNlbGVjdG9yIGZvciB0aGlzXG4gICAgICAgICAgLy8gcGF0aC4gSWYgbm90aGluZyBtYXRjaGVzLCByZXR1cm5zIGB1bmRlZmluZWRgIGFzIG5vdGhpbmcgY2FuIG1ha2VcbiAgICAgICAgICAvLyB0aGlzIHNlbGVjdG9yIGludG8gYHRydWVgLlxuICAgICAgICAgIHJldHVybiB2YWx1ZVNlbGVjdG9yLiRpbi5maW5kKHBsYWNlaG9sZGVyID0+XG4gICAgICAgICAgICBtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyh7cGxhY2Vob2xkZXJ9KS5yZXN1bHRcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9ubHlDb250YWluc0tleXModmFsdWVTZWxlY3RvciwgWyckZ3QnLCAnJGd0ZScsICckbHQnLCAnJGx0ZSddKSkge1xuICAgICAgICAgIGxldCBsb3dlckJvdW5kID0gLUluZmluaXR5O1xuICAgICAgICAgIGxldCB1cHBlckJvdW5kID0gSW5maW5pdHk7XG5cbiAgICAgICAgICBbJyRsdGUnLCAnJGx0J10uZm9yRWFjaChvcCA9PiB7XG4gICAgICAgICAgICBpZiAoaGFzT3duLmNhbGwodmFsdWVTZWxlY3Rvciwgb3ApICYmXG4gICAgICAgICAgICAgICAgdmFsdWVTZWxlY3RvcltvcF0gPCB1cHBlckJvdW5kKSB7XG4gICAgICAgICAgICAgIHVwcGVyQm91bmQgPSB2YWx1ZVNlbGVjdG9yW29wXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIFsnJGd0ZScsICckZ3QnXS5mb3JFYWNoKG9wID0+IHtcbiAgICAgICAgICAgIGlmIChoYXNPd24uY2FsbCh2YWx1ZVNlbGVjdG9yLCBvcCkgJiZcbiAgICAgICAgICAgICAgICB2YWx1ZVNlbGVjdG9yW29wXSA+IGxvd2VyQm91bmQpIHtcbiAgICAgICAgICAgICAgbG93ZXJCb3VuZCA9IHZhbHVlU2VsZWN0b3Jbb3BdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY29uc3QgbWlkZGxlID0gKGxvd2VyQm91bmQgKyB1cHBlckJvdW5kKSAvIDI7XG4gICAgICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcih7cGxhY2Vob2xkZXI6IHZhbHVlU2VsZWN0b3J9KTtcblxuICAgICAgICAgIGlmICghbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoe3BsYWNlaG9sZGVyOiBtaWRkbGV9KS5yZXN1bHQgJiZcbiAgICAgICAgICAgICAgKG1pZGRsZSA9PT0gbG93ZXJCb3VuZCB8fCBtaWRkbGUgPT09IHVwcGVyQm91bmQpKSB7XG4gICAgICAgICAgICBmYWxsYmFjayA9IHRydWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIG1pZGRsZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvbmx5Q29udGFpbnNLZXlzKHZhbHVlU2VsZWN0b3IsIFsnJG5pbicsICckbmUnXSkpIHtcbiAgICAgICAgICAvLyBTaW5jZSB0aGlzLl9pc1NpbXBsZSBtYWtlcyBzdXJlICRuaW4gYW5kICRuZSBhcmUgbm90IGNvbWJpbmVkIHdpdGhcbiAgICAgICAgICAvLyBvYmplY3RzIG9yIGFycmF5cywgd2UgY2FuIGNvbmZpZGVudGx5IHJldHVybiBhbiBlbXB0eSBvYmplY3QgYXMgaXRcbiAgICAgICAgICAvLyBuZXZlciBtYXRjaGVzIGFueSBzY2FsYXIuXG4gICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgZmFsbGJhY2sgPSB0cnVlO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fc2VsZWN0b3JbcGF0aF07XG4gICAgfSxcbiAgICB4ID0+IHgpO1xuXG4gIGlmIChmYWxsYmFjaykge1xuICAgIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQ7XG59O1xuXG4vLyBNaW5pbW9uZ28uU29ydGVyIGdldHMgYSBzaW1pbGFyIG1ldGhvZCwgd2hpY2ggZGVsZWdhdGVzIHRvIGEgTWF0Y2hlciBpdCBtYWRlXG4vLyBmb3IgdGhpcyBleGFjdCBwdXJwb3NlLlxuTWluaW1vbmdvLlNvcnRlci5wcm90b3R5cGUuYWZmZWN0ZWRCeU1vZGlmaWVyID0gZnVuY3Rpb24obW9kaWZpZXIpIHtcbiAgcmV0dXJuIHRoaXMuX3NlbGVjdG9yRm9yQWZmZWN0ZWRCeU1vZGlmaWVyLmFmZmVjdGVkQnlNb2RpZmllcihtb2RpZmllcik7XG59O1xuXG5NaW5pbW9uZ28uU29ydGVyLnByb3RvdHlwZS5jb21iaW5lSW50b1Byb2plY3Rpb24gPSBmdW5jdGlvbihwcm9qZWN0aW9uKSB7XG4gIHJldHVybiBjb21iaW5lSW1wb3J0YW50UGF0aHNJbnRvUHJvamVjdGlvbihcbiAgICBNaW5pbW9uZ28uX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzKHRoaXMuX2dldFBhdGhzKCkpLFxuICAgIHByb2plY3Rpb25cbiAgKTtcbn07XG5cbmZ1bmN0aW9uIGNvbWJpbmVJbXBvcnRhbnRQYXRoc0ludG9Qcm9qZWN0aW9uKHBhdGhzLCBwcm9qZWN0aW9uKSB7XG4gIGNvbnN0IGRldGFpbHMgPSBwcm9qZWN0aW9uRGV0YWlscyhwcm9qZWN0aW9uKTtcblxuICAvLyBtZXJnZSB0aGUgcGF0aHMgdG8gaW5jbHVkZVxuICBjb25zdCB0cmVlID0gcGF0aHNUb1RyZWUoXG4gICAgcGF0aHMsXG4gICAgcGF0aCA9PiB0cnVlLFxuICAgIChub2RlLCBwYXRoLCBmdWxsUGF0aCkgPT4gdHJ1ZSxcbiAgICBkZXRhaWxzLnRyZWVcbiAgKTtcbiAgY29uc3QgbWVyZ2VkUHJvamVjdGlvbiA9IHRyZWVUb1BhdGhzKHRyZWUpO1xuXG4gIGlmIChkZXRhaWxzLmluY2x1ZGluZykge1xuICAgIC8vIGJvdGggc2VsZWN0b3IgYW5kIHByb2plY3Rpb24gYXJlIHBvaW50aW5nIG9uIGZpZWxkcyB0byBpbmNsdWRlXG4gICAgLy8gc28gd2UgY2FuIGp1c3QgcmV0dXJuIHRoZSBtZXJnZWQgdHJlZVxuICAgIHJldHVybiBtZXJnZWRQcm9qZWN0aW9uO1xuICB9XG5cbiAgLy8gc2VsZWN0b3IgaXMgcG9pbnRpbmcgYXQgZmllbGRzIHRvIGluY2x1ZGVcbiAgLy8gcHJvamVjdGlvbiBpcyBwb2ludGluZyBhdCBmaWVsZHMgdG8gZXhjbHVkZVxuICAvLyBtYWtlIHN1cmUgd2UgZG9uJ3QgZXhjbHVkZSBpbXBvcnRhbnQgcGF0aHNcbiAgY29uc3QgbWVyZ2VkRXhjbFByb2plY3Rpb24gPSB7fTtcblxuICBPYmplY3Qua2V5cyhtZXJnZWRQcm9qZWN0aW9uKS5mb3JFYWNoKHBhdGggPT4ge1xuICAgIGlmICghbWVyZ2VkUHJvamVjdGlvbltwYXRoXSkge1xuICAgICAgbWVyZ2VkRXhjbFByb2plY3Rpb25bcGF0aF0gPSBmYWxzZTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBtZXJnZWRFeGNsUHJvamVjdGlvbjtcbn1cblxuZnVuY3Rpb24gZ2V0UGF0aHMoc2VsZWN0b3IpIHtcbiAgcmV0dXJuIE9iamVjdC5rZXlzKG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3RvcikuX3BhdGhzKTtcblxuICAvLyBYWFggcmVtb3ZlIGl0P1xuICAvLyByZXR1cm4gT2JqZWN0LmtleXMoc2VsZWN0b3IpLm1hcChrID0+IHtcbiAgLy8gICAvLyB3ZSBkb24ndCBrbm93IGhvdyB0byBoYW5kbGUgJHdoZXJlIGJlY2F1c2UgaXQgY2FuIGJlIGFueXRoaW5nXG4gIC8vICAgaWYgKGsgPT09ICckd2hlcmUnKSB7XG4gIC8vICAgICByZXR1cm4gJyc7IC8vIG1hdGNoZXMgZXZlcnl0aGluZ1xuICAvLyAgIH1cblxuICAvLyAgIC8vIHdlIGJyYW5jaCBmcm9tICRvci8kYW5kLyRub3Igb3BlcmF0b3JcbiAgLy8gICBpZiAoWyckb3InLCAnJGFuZCcsICckbm9yJ10uaW5jbHVkZXMoaykpIHtcbiAgLy8gICAgIHJldHVybiBzZWxlY3RvcltrXS5tYXAoZ2V0UGF0aHMpO1xuICAvLyAgIH1cblxuICAvLyAgIC8vIHRoZSB2YWx1ZSBpcyBhIGxpdGVyYWwgb3Igc29tZSBjb21wYXJpc29uIG9wZXJhdG9yXG4gIC8vICAgcmV0dXJuIGs7XG4gIC8vIH0pXG4gIC8vICAgLnJlZHVjZSgoYSwgYikgPT4gYS5jb25jYXQoYiksIFtdKVxuICAvLyAgIC5maWx0ZXIoKGEsIGIsIGMpID0+IGMuaW5kZXhPZihhKSA9PT0gYik7XG59XG5cbi8vIEEgaGVscGVyIHRvIGVuc3VyZSBvYmplY3QgaGFzIG9ubHkgY2VydGFpbiBrZXlzXG5mdW5jdGlvbiBvbmx5Q29udGFpbnNLZXlzKG9iaiwga2V5cykge1xuICByZXR1cm4gT2JqZWN0LmtleXMob2JqKS5ldmVyeShrID0+IGtleXMuaW5jbHVkZXMoaykpO1xufVxuXG5mdW5jdGlvbiBwYXRoSGFzTnVtZXJpY0tleXMocGF0aCkge1xuICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnNvbWUoaXNOdW1lcmljS2V5KTtcbn1cblxuLy8gUmV0dXJucyBhIHNldCBvZiBrZXkgcGF0aHMgc2ltaWxhciB0b1xuLy8geyAnZm9vLmJhcic6IDEsICdhLmIuYyc6IDEgfVxuZnVuY3Rpb24gdHJlZVRvUGF0aHModHJlZSwgcHJlZml4ID0gJycpIHtcbiAgY29uc3QgcmVzdWx0ID0ge307XG5cbiAgT2JqZWN0LmtleXModHJlZSkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gdHJlZVtrZXldO1xuICAgIGlmICh2YWx1ZSA9PT0gT2JqZWN0KHZhbHVlKSkge1xuICAgICAgT2JqZWN0LmFzc2lnbihyZXN1bHQsIHRyZWVUb1BhdGhzKHZhbHVlLCBgJHtwcmVmaXggKyBrZXl9LmApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0W3ByZWZpeCArIGtleV0gPSB2YWx1ZTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiByZXN1bHQ7XG59XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5cbmV4cG9ydCBjb25zdCBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5O1xuXG4vLyBFYWNoIGVsZW1lbnQgc2VsZWN0b3IgY29udGFpbnM6XG4vLyAgLSBjb21waWxlRWxlbWVudFNlbGVjdG9yLCBhIGZ1bmN0aW9uIHdpdGggYXJnczpcbi8vICAgIC0gb3BlcmFuZCAtIHRoZSBcInJpZ2h0IGhhbmQgc2lkZVwiIG9mIHRoZSBvcGVyYXRvclxuLy8gICAgLSB2YWx1ZVNlbGVjdG9yIC0gdGhlIFwiY29udGV4dFwiIGZvciB0aGUgb3BlcmF0b3IgKHNvIHRoYXQgJHJlZ2V4IGNhbiBmaW5kXG4vLyAgICAgICRvcHRpb25zKVxuLy8gICAgLSBtYXRjaGVyIC0gdGhlIE1hdGNoZXIgdGhpcyBpcyBnb2luZyBpbnRvIChzbyB0aGF0ICRlbGVtTWF0Y2ggY2FuIGNvbXBpbGVcbi8vICAgICAgbW9yZSB0aGluZ3MpXG4vLyAgICByZXR1cm5pbmcgYSBmdW5jdGlvbiBtYXBwaW5nIGEgc2luZ2xlIHZhbHVlIHRvIGJvb2wuXG4vLyAgLSBkb250RXhwYW5kTGVhZkFycmF5cywgYSBib29sIHdoaWNoIHByZXZlbnRzIGV4cGFuZEFycmF5c0luQnJhbmNoZXMgZnJvbVxuLy8gICAgYmVpbmcgY2FsbGVkXG4vLyAgLSBkb250SW5jbHVkZUxlYWZBcnJheXMsIGEgYm9vbCB3aGljaCBjYXVzZXMgYW4gYXJndW1lbnQgdG8gYmUgcGFzc2VkIHRvXG4vLyAgICBleHBhbmRBcnJheXNJbkJyYW5jaGVzIGlmIGl0IGlzIGNhbGxlZFxuZXhwb3J0IGNvbnN0IEVMRU1FTlRfT1BFUkFUT1JTID0ge1xuICAkbHQ6IG1ha2VJbmVxdWFsaXR5KGNtcFZhbHVlID0+IGNtcFZhbHVlIDwgMCksXG4gICRndDogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPiAwKSxcbiAgJGx0ZTogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPD0gMCksXG4gICRndGU6IG1ha2VJbmVxdWFsaXR5KGNtcFZhbHVlID0+IGNtcFZhbHVlID49IDApLFxuICAkbW9kOiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBpZiAoIShBcnJheS5pc0FycmF5KG9wZXJhbmQpICYmIG9wZXJhbmQubGVuZ3RoID09PSAyXG4gICAgICAgICAgICAmJiB0eXBlb2Ygb3BlcmFuZFswXSA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICYmIHR5cGVvZiBvcGVyYW5kWzFdID09PSAnbnVtYmVyJykpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ2FyZ3VtZW50IHRvICRtb2QgbXVzdCBiZSBhbiBhcnJheSBvZiB0d28gbnVtYmVycycpO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggY291bGQgcmVxdWlyZSB0byBiZSBpbnRzIG9yIHJvdW5kIG9yIHNvbWV0aGluZ1xuICAgICAgY29uc3QgZGl2aXNvciA9IG9wZXJhbmRbMF07XG4gICAgICBjb25zdCByZW1haW5kZXIgPSBvcGVyYW5kWzFdO1xuICAgICAgcmV0dXJuIHZhbHVlID0+IChcbiAgICAgICAgdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiB2YWx1ZSAlIGRpdmlzb3IgPT09IHJlbWFpbmRlclxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICAkaW46IHtcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignJGluIG5lZWRzIGFuIGFycmF5Jyk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVsZW1lbnRNYXRjaGVycyA9IG9wZXJhbmQubWFwKG9wdGlvbiA9PiB7XG4gICAgICAgIGlmIChvcHRpb24gaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgICAgICByZXR1cm4gcmVnZXhwRWxlbWVudE1hdGNoZXIob3B0aW9uKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpc09wZXJhdG9yT2JqZWN0KG9wdGlvbikpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IG5lc3QgJCB1bmRlciAkaW4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlcXVhbGl0eUVsZW1lbnRNYXRjaGVyKG9wdGlvbik7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgLy8gQWxsb3cge2E6IHskaW46IFtudWxsXX19IHRvIG1hdGNoIHdoZW4gJ2EnIGRvZXMgbm90IGV4aXN0LlxuICAgICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlbGVtZW50TWF0Y2hlcnMuc29tZShtYXRjaGVyID0+IG1hdGNoZXIodmFsdWUpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJHNpemU6IHtcbiAgICAvLyB7YTogW1s1LCA1XV19IG11c3QgbWF0Y2gge2E6IHskc2l6ZTogMX19IGJ1dCBub3Qge2E6IHskc2l6ZTogMn19LCBzbyB3ZVxuICAgIC8vIGRvbid0IHdhbnQgdG8gY29uc2lkZXIgdGhlIGVsZW1lbnQgWzUsNV0gaW4gdGhlIGxlYWYgYXJyYXkgW1s1LDVdXSBhcyBhXG4gICAgLy8gcG9zc2libGUgdmFsdWUuXG4gICAgZG9udEV4cGFuZExlYWZBcnJheXM6IHRydWUsXG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBpZiAodHlwZW9mIG9wZXJhbmQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIC8vIERvbid0IGFzayBtZSB3aHksIGJ1dCBieSBleHBlcmltZW50YXRpb24sIHRoaXMgc2VlbXMgdG8gYmUgd2hhdCBNb25nb1xuICAgICAgICAvLyBkb2VzLlxuICAgICAgICBvcGVyYW5kID0gMDtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9wZXJhbmQgIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckc2l6ZSBuZWVkcyBhIG51bWJlcicpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdmFsdWUgPT4gQXJyYXkuaXNBcnJheSh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID09PSBvcGVyYW5kO1xuICAgIH0sXG4gIH0sXG4gICR0eXBlOiB7XG4gICAgLy8ge2E6IFs1XX0gbXVzdCBub3QgbWF0Y2gge2E6IHskdHlwZTogNH19ICg0IG1lYW5zIGFycmF5KSwgYnV0IGl0IHNob3VsZFxuICAgIC8vIG1hdGNoIHthOiB7JHR5cGU6IDF9fSAoMSBtZWFucyBudW1iZXIpLCBhbmQge2E6IFtbNV1dfSBtdXN0IG1hdGNoIHskYTpcbiAgICAvLyB7JHR5cGU6IDR9fS4gVGh1cywgd2hlbiB3ZSBzZWUgYSBsZWFmIGFycmF5LCB3ZSAqc2hvdWxkKiBleHBhbmQgaXQgYnV0XG4gICAgLy8gc2hvdWxkICpub3QqIGluY2x1ZGUgaXQgaXRzZWxmLlxuICAgIGRvbnRJbmNsdWRlTGVhZkFycmF5czogdHJ1ZSxcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICh0eXBlb2Ygb3BlcmFuZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgb3BlcmFuZEFsaWFzTWFwID0ge1xuICAgICAgICAgICdkb3VibGUnOiAxLFxuICAgICAgICAgICdzdHJpbmcnOiAyLFxuICAgICAgICAgICdvYmplY3QnOiAzLFxuICAgICAgICAgICdhcnJheSc6IDQsXG4gICAgICAgICAgJ2JpbkRhdGEnOiA1LFxuICAgICAgICAgICd1bmRlZmluZWQnOiA2LFxuICAgICAgICAgICdvYmplY3RJZCc6IDcsXG4gICAgICAgICAgJ2Jvb2wnOiA4LFxuICAgICAgICAgICdkYXRlJzogOSxcbiAgICAgICAgICAnbnVsbCc6IDEwLFxuICAgICAgICAgICdyZWdleCc6IDExLFxuICAgICAgICAgICdkYlBvaW50ZXInOiAxMixcbiAgICAgICAgICAnamF2YXNjcmlwdCc6IDEzLFxuICAgICAgICAgICdzeW1ib2wnOiAxNCxcbiAgICAgICAgICAnamF2YXNjcmlwdFdpdGhTY29wZSc6IDE1LFxuICAgICAgICAgICdpbnQnOiAxNixcbiAgICAgICAgICAndGltZXN0YW1wJzogMTcsXG4gICAgICAgICAgJ2xvbmcnOiAxOCxcbiAgICAgICAgICAnZGVjaW1hbCc6IDE5LFxuICAgICAgICAgICdtaW5LZXknOiAtMSxcbiAgICAgICAgICAnbWF4S2V5JzogMTI3LFxuICAgICAgICB9O1xuICAgICAgICBpZiAoIWhhc093bi5jYWxsKG9wZXJhbmRBbGlhc01hcCwgb3BlcmFuZCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihgdW5rbm93biBzdHJpbmcgYWxpYXMgZm9yICR0eXBlOiAke29wZXJhbmR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgb3BlcmFuZCA9IG9wZXJhbmRBbGlhc01hcFtvcGVyYW5kXTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9wZXJhbmQgPT09ICdudW1iZXInKSB7XG4gICAgICAgIGlmIChvcGVyYW5kID09PSAwIHx8IG9wZXJhbmQgPCAtMVxuICAgICAgICAgIHx8IChvcGVyYW5kID4gMTkgJiYgb3BlcmFuZCAhPT0gMTI3KSkge1xuICAgICAgICAgIHRocm93IEVycm9yKGBJbnZhbGlkIG51bWVyaWNhbCAkdHlwZSBjb2RlOiAke29wZXJhbmR9YCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IEVycm9yKCdhcmd1bWVudCB0byAkdHlwZSBpcyBub3QgYSBudW1iZXIgb3IgYSBzdHJpbmcnKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHZhbHVlID0+IChcbiAgICAgICAgdmFsdWUgIT09IHVuZGVmaW5lZCAmJiBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUodmFsdWUpID09PSBvcGVyYW5kXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gICRiaXRzQWxsU2V0OiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBjb25zdCBtYXNrID0gZ2V0T3BlcmFuZEJpdG1hc2sob3BlcmFuZCwgJyRiaXRzQWxsU2V0Jyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suZXZlcnkoKGJ5dGUsIGkpID0+IChiaXRtYXNrW2ldICYgYnl0ZSkgPT09IGJ5dGUpO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICAkYml0c0FueVNldDoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FueVNldCcpO1xuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgY29uc3QgYml0bWFzayA9IGdldFZhbHVlQml0bWFzayh2YWx1ZSwgbWFzay5sZW5ndGgpO1xuICAgICAgICByZXR1cm4gYml0bWFzayAmJiBtYXNrLnNvbWUoKGJ5dGUsIGkpID0+ICh+Yml0bWFza1tpXSAmIGJ5dGUpICE9PSBieXRlKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJGJpdHNBbGxDbGVhcjoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FsbENsZWFyJyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suZXZlcnkoKGJ5dGUsIGkpID0+ICEoYml0bWFza1tpXSAmIGJ5dGUpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJGJpdHNBbnlDbGVhcjoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FueUNsZWFyJyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suc29tZSgoYnl0ZSwgaSkgPT4gKGJpdG1hc2tbaV0gJiBieXRlKSAhPT0gYnl0ZSk7XG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gICRyZWdleDoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCwgdmFsdWVTZWxlY3Rvcikge1xuICAgICAgaWYgKCEodHlwZW9mIG9wZXJhbmQgPT09ICdzdHJpbmcnIHx8IG9wZXJhbmQgaW5zdGFuY2VvZiBSZWdFeHApKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckcmVnZXggaGFzIHRvIGJlIGEgc3RyaW5nIG9yIFJlZ0V4cCcpO1xuICAgICAgfVxuXG4gICAgICBsZXQgcmVnZXhwO1xuICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJG9wdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBPcHRpb25zIHBhc3NlZCBpbiAkb3B0aW9ucyAoZXZlbiB0aGUgZW1wdHkgc3RyaW5nKSBhbHdheXMgb3ZlcnJpZGVzXG4gICAgICAgIC8vIG9wdGlvbnMgaW4gdGhlIFJlZ0V4cCBvYmplY3QgaXRzZWxmLlxuXG4gICAgICAgIC8vIEJlIGNsZWFyIHRoYXQgd2Ugb25seSBzdXBwb3J0IHRoZSBKUy1zdXBwb3J0ZWQgb3B0aW9ucywgbm90IGV4dGVuZGVkXG4gICAgICAgIC8vIG9uZXMgKGVnLCBNb25nbyBzdXBwb3J0cyB4IGFuZCBzKS4gSWRlYWxseSB3ZSB3b3VsZCBpbXBsZW1lbnQgeCBhbmQgc1xuICAgICAgICAvLyBieSB0cmFuc2Zvcm1pbmcgdGhlIHJlZ2V4cCwgYnV0IG5vdCB0b2RheS4uLlxuICAgICAgICBpZiAoL1teZ2ltXS8udGVzdCh2YWx1ZVNlbGVjdG9yLiRvcHRpb25zKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSB0aGUgaSwgbSwgYW5kIGcgcmVnZXhwIG9wdGlvbnMgYXJlIHN1cHBvcnRlZCcpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc291cmNlID0gb3BlcmFuZCBpbnN0YW5jZW9mIFJlZ0V4cCA/IG9wZXJhbmQuc291cmNlIDogb3BlcmFuZDtcbiAgICAgICAgcmVnZXhwID0gbmV3IFJlZ0V4cChzb3VyY2UsIHZhbHVlU2VsZWN0b3IuJG9wdGlvbnMpO1xuICAgICAgfSBlbHNlIGlmIChvcGVyYW5kIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICAgIHJlZ2V4cCA9IG9wZXJhbmQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWdleHAgPSBuZXcgUmVnRXhwKG9wZXJhbmQpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVnZXhwRWxlbWVudE1hdGNoZXIocmVnZXhwKTtcbiAgICB9LFxuICB9LFxuICAkZWxlbU1hdGNoOiB7XG4gICAgZG9udEV4cGFuZExlYWZBcnJheXM6IHRydWUsXG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSB7XG4gICAgICBpZiAoIUxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChvcGVyYW5kKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignJGVsZW1NYXRjaCBuZWVkIGFuIG9iamVjdCcpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpc0RvY01hdGNoZXIgPSAhaXNPcGVyYXRvck9iamVjdChcbiAgICAgICAgT2JqZWN0LmtleXMob3BlcmFuZClcbiAgICAgICAgICAuZmlsdGVyKGtleSA9PiAhaGFzT3duLmNhbGwoTE9HSUNBTF9PUEVSQVRPUlMsIGtleSkpXG4gICAgICAgICAgLnJlZHVjZSgoYSwgYikgPT4gT2JqZWN0LmFzc2lnbihhLCB7W2JdOiBvcGVyYW5kW2JdfSksIHt9KSxcbiAgICAgICAgdHJ1ZSk7XG5cbiAgICAgIGxldCBzdWJNYXRjaGVyO1xuICAgICAgaWYgKGlzRG9jTWF0Y2hlcikge1xuICAgICAgICAvLyBUaGlzIGlzIE5PVCB0aGUgc2FtZSBhcyBjb21waWxlVmFsdWVTZWxlY3RvcihvcGVyYW5kKSwgYW5kIG5vdCBqdXN0XG4gICAgICAgIC8vIGJlY2F1c2Ugb2YgdGhlIHNsaWdodGx5IGRpZmZlcmVudCBjYWxsaW5nIGNvbnZlbnRpb24uXG4gICAgICAgIC8vIHskZWxlbU1hdGNoOiB7eDogM319IG1lYW5zIFwiYW4gZWxlbWVudCBoYXMgYSBmaWVsZCB4OjNcIiwgbm90XG4gICAgICAgIC8vIFwiY29uc2lzdHMgb25seSBvZiBhIGZpZWxkIHg6M1wiLiBBbHNvLCByZWdleHBzIGFuZCBzdWItJCBhcmUgYWxsb3dlZC5cbiAgICAgICAgc3ViTWF0Y2hlciA9XG4gICAgICAgICAgY29tcGlsZURvY3VtZW50U2VsZWN0b3Iob3BlcmFuZCwgbWF0Y2hlciwge2luRWxlbU1hdGNoOiB0cnVlfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdWJNYXRjaGVyID0gY29tcGlsZVZhbHVlU2VsZWN0b3Iob3BlcmFuZCwgbWF0Y2hlcik7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHZhbHVlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgY29uc3QgYXJyYXlFbGVtZW50ID0gdmFsdWVbaV07XG4gICAgICAgICAgbGV0IGFyZztcbiAgICAgICAgICBpZiAoaXNEb2NNYXRjaGVyKSB7XG4gICAgICAgICAgICAvLyBXZSBjYW4gb25seSBtYXRjaCB7JGVsZW1NYXRjaDoge2I6IDN9fSBhZ2FpbnN0IG9iamVjdHMuXG4gICAgICAgICAgICAvLyAoV2UgY2FuIGFsc28gbWF0Y2ggYWdhaW5zdCBhcnJheXMsIGlmIHRoZXJlJ3MgbnVtZXJpYyBpbmRpY2VzLFxuICAgICAgICAgICAgLy8gZWcgeyRlbGVtTWF0Y2g6IHsnMC5iJzogM319IG9yIHskZWxlbU1hdGNoOiB7MDogM319LilcbiAgICAgICAgICAgIGlmICghaXNJbmRleGFibGUoYXJyYXlFbGVtZW50KSkge1xuICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFyZyA9IGFycmF5RWxlbWVudDtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gZG9udEl0ZXJhdGUgZW5zdXJlcyB0aGF0IHthOiB7JGVsZW1NYXRjaDogeyRndDogNX19fSBtYXRjaGVzXG4gICAgICAgICAgICAvLyB7YTogWzhdfSBidXQgbm90IHthOiBbWzhdXX1cbiAgICAgICAgICAgIGFyZyA9IFt7dmFsdWU6IGFycmF5RWxlbWVudCwgZG9udEl0ZXJhdGU6IHRydWV9XTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gWFhYIHN1cHBvcnQgJG5lYXIgaW4gJGVsZW1NYXRjaCBieSBwcm9wYWdhdGluZyAkZGlzdGFuY2U/XG4gICAgICAgICAgaWYgKHN1Yk1hdGNoZXIoYXJnKS5yZXN1bHQpIHtcbiAgICAgICAgICAgIHJldHVybiBpOyAvLyBzcGVjaWFsbHkgdW5kZXJzdG9vZCB0byBtZWFuIFwidXNlIGFzIGFycmF5SW5kaWNlc1wiXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxufTtcblxuLy8gT3BlcmF0b3JzIHRoYXQgYXBwZWFyIGF0IHRoZSB0b3AgbGV2ZWwgb2YgYSBkb2N1bWVudCBzZWxlY3Rvci5cbmNvbnN0IExPR0lDQUxfT1BFUkFUT1JTID0ge1xuICAkYW5kKHN1YlNlbGVjdG9yLCBtYXRjaGVyLCBpbkVsZW1NYXRjaCkge1xuICAgIHJldHVybiBhbmREb2N1bWVudE1hdGNoZXJzKFxuICAgICAgY29tcGlsZUFycmF5T2ZEb2N1bWVudFNlbGVjdG9ycyhzdWJTZWxlY3RvciwgbWF0Y2hlciwgaW5FbGVtTWF0Y2gpXG4gICAgKTtcbiAgfSxcblxuICAkb3Ioc3ViU2VsZWN0b3IsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gICAgY29uc3QgbWF0Y2hlcnMgPSBjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzKFxuICAgICAgc3ViU2VsZWN0b3IsXG4gICAgICBtYXRjaGVyLFxuICAgICAgaW5FbGVtTWF0Y2hcbiAgICApO1xuXG4gICAgLy8gU3BlY2lhbCBjYXNlOiBpZiB0aGVyZSBpcyBvbmx5IG9uZSBtYXRjaGVyLCB1c2UgaXQgZGlyZWN0bHksICpwcmVzZXJ2aW5nKlxuICAgIC8vIGFueSBhcnJheUluZGljZXMgaXQgcmV0dXJucy5cbiAgICBpZiAobWF0Y2hlcnMubGVuZ3RoID09PSAxKSB7XG4gICAgICByZXR1cm4gbWF0Y2hlcnNbMF07XG4gICAgfVxuXG4gICAgcmV0dXJuIGRvYyA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBtYXRjaGVycy5zb21lKGZuID0+IGZuKGRvYykucmVzdWx0KTtcbiAgICAgIC8vICRvciBkb2VzIE5PVCBzZXQgYXJyYXlJbmRpY2VzIHdoZW4gaXQgaGFzIG11bHRpcGxlXG4gICAgICAvLyBzdWItZXhwcmVzc2lvbnMuIChUZXN0ZWQgYWdhaW5zdCBNb25nb0RCLilcbiAgICAgIHJldHVybiB7cmVzdWx0fTtcbiAgICB9O1xuICB9LFxuXG4gICRub3Ioc3ViU2VsZWN0b3IsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gICAgY29uc3QgbWF0Y2hlcnMgPSBjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzKFxuICAgICAgc3ViU2VsZWN0b3IsXG4gICAgICBtYXRjaGVyLFxuICAgICAgaW5FbGVtTWF0Y2hcbiAgICApO1xuICAgIHJldHVybiBkb2MgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gbWF0Y2hlcnMuZXZlcnkoZm4gPT4gIWZuKGRvYykucmVzdWx0KTtcbiAgICAgIC8vIE5ldmVyIHNldCBhcnJheUluZGljZXMsIGJlY2F1c2Ugd2Ugb25seSBtYXRjaCBpZiBub3RoaW5nIGluIHBhcnRpY3VsYXJcbiAgICAgIC8vICdtYXRjaGVkJyAoYW5kIGJlY2F1c2UgdGhpcyBpcyBjb25zaXN0ZW50IHdpdGggTW9uZ29EQikuXG4gICAgICByZXR1cm4ge3Jlc3VsdH07XG4gICAgfTtcbiAgfSxcblxuICAkd2hlcmUoc2VsZWN0b3JWYWx1ZSwgbWF0Y2hlcikge1xuICAgIC8vIFJlY29yZCB0aGF0ICphbnkqIHBhdGggbWF5IGJlIHVzZWQuXG4gICAgbWF0Y2hlci5fcmVjb3JkUGF0aFVzZWQoJycpO1xuICAgIG1hdGNoZXIuX2hhc1doZXJlID0gdHJ1ZTtcblxuICAgIGlmICghKHNlbGVjdG9yVmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikpIHtcbiAgICAgIC8vIFhYWCBNb25nb0RCIHNlZW1zIHRvIGhhdmUgbW9yZSBjb21wbGV4IGxvZ2ljIHRvIGRlY2lkZSB3aGVyZSBvciBvciBub3RcbiAgICAgIC8vIHRvIGFkZCAncmV0dXJuJzsgbm90IHN1cmUgZXhhY3RseSB3aGF0IGl0IGlzLlxuICAgICAgc2VsZWN0b3JWYWx1ZSA9IEZ1bmN0aW9uKCdvYmonLCBgcmV0dXJuICR7c2VsZWN0b3JWYWx1ZX1gKTtcbiAgICB9XG5cbiAgICAvLyBXZSBtYWtlIHRoZSBkb2N1bWVudCBhdmFpbGFibGUgYXMgYm90aCBgdGhpc2AgYW5kIGBvYmpgLlxuICAgIC8vIC8vIFhYWCBub3Qgc3VyZSB3aGF0IHdlIHNob3VsZCBkbyBpZiB0aGlzIHRocm93c1xuICAgIHJldHVybiBkb2MgPT4gKHtyZXN1bHQ6IHNlbGVjdG9yVmFsdWUuY2FsbChkb2MsIGRvYyl9KTtcbiAgfSxcblxuICAvLyBUaGlzIGlzIGp1c3QgdXNlZCBhcyBhIGNvbW1lbnQgaW4gdGhlIHF1ZXJ5IChpbiBNb25nb0RCLCBpdCBhbHNvIGVuZHMgdXAgaW5cbiAgLy8gcXVlcnkgbG9ncyk7IGl0IGhhcyBubyBlZmZlY3Qgb24gdGhlIGFjdHVhbCBzZWxlY3Rpb24uXG4gICRjb21tZW50KCkge1xuICAgIHJldHVybiAoKSA9PiAoe3Jlc3VsdDogdHJ1ZX0pO1xuICB9LFxufTtcblxuLy8gT3BlcmF0b3JzIHRoYXQgKHVubGlrZSBMT0dJQ0FMX09QRVJBVE9SUykgcGVydGFpbiB0byBpbmRpdmlkdWFsIHBhdGhzIGluIGFcbi8vIGRvY3VtZW50LCBidXQgKHVubGlrZSBFTEVNRU5UX09QRVJBVE9SUykgZG8gbm90IGhhdmUgYSBzaW1wbGUgZGVmaW5pdGlvbiBhc1xuLy8gXCJtYXRjaCBlYWNoIGJyYW5jaGVkIHZhbHVlIGluZGVwZW5kZW50bHkgYW5kIGNvbWJpbmUgd2l0aFxuLy8gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXJcIi5cbmNvbnN0IFZBTFVFX09QRVJBVE9SUyA9IHtcbiAgJGVxKG9wZXJhbmQpIHtcbiAgICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICBlcXVhbGl0eUVsZW1lbnRNYXRjaGVyKG9wZXJhbmQpXG4gICAgKTtcbiAgfSxcbiAgJG5vdChvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihjb21waWxlVmFsdWVTZWxlY3RvcihvcGVyYW5kLCBtYXRjaGVyKSk7XG4gIH0sXG4gICRuZShvcGVyYW5kKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihcbiAgICAgIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKGVxdWFsaXR5RWxlbWVudE1hdGNoZXIob3BlcmFuZCkpXG4gICAgKTtcbiAgfSxcbiAgJG5pbihvcGVyYW5kKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihcbiAgICAgIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgICAgICBFTEVNRU5UX09QRVJBVE9SUy4kaW4uY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKVxuICAgICAgKVxuICAgICk7XG4gIH0sXG4gICRleGlzdHMob3BlcmFuZCkge1xuICAgIGNvbnN0IGV4aXN0cyA9IGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgICAgdmFsdWUgPT4gdmFsdWUgIT09IHVuZGVmaW5lZFxuICAgICk7XG4gICAgcmV0dXJuIG9wZXJhbmQgPyBleGlzdHMgOiBpbnZlcnRCcmFuY2hlZE1hdGNoZXIoZXhpc3RzKTtcbiAgfSxcbiAgLy8gJG9wdGlvbnMganVzdCBwcm92aWRlcyBvcHRpb25zIGZvciAkcmVnZXg7IGl0cyBsb2dpYyBpcyBpbnNpZGUgJHJlZ2V4XG4gICRvcHRpb25zKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IpIHtcbiAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlU2VsZWN0b3IsICckcmVnZXgnKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRvcHRpb25zIG5lZWRzIGEgJHJlZ2V4Jyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGV2ZXJ5dGhpbmdNYXRjaGVyO1xuICB9LFxuICAvLyAkbWF4RGlzdGFuY2UgaXMgYmFzaWNhbGx5IGFuIGFyZ3VtZW50IHRvICRuZWFyXG4gICRtYXhEaXN0YW5jZShvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yKSB7XG4gICAgaWYgKCF2YWx1ZVNlbGVjdG9yLiRuZWFyKSB7XG4gICAgICB0aHJvdyBFcnJvcignJG1heERpc3RhbmNlIG5lZWRzIGEgJG5lYXInKTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXZlcnl0aGluZ01hdGNoZXI7XG4gIH0sXG4gICRhbGwob3BlcmFuZCwgdmFsdWVTZWxlY3RvciwgbWF0Y2hlcikge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRhbGwgcmVxdWlyZXMgYXJyYXknKTtcbiAgICB9XG5cbiAgICAvLyBOb3Qgc3VyZSB3aHksIGJ1dCB0aGlzIHNlZW1zIHRvIGJlIHdoYXQgTW9uZ29EQiBkb2VzLlxuICAgIGlmIChvcGVyYW5kLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIG5vdGhpbmdNYXRjaGVyO1xuICAgIH1cblxuICAgIGNvbnN0IGJyYW5jaGVkTWF0Y2hlcnMgPSBvcGVyYW5kLm1hcChjcml0ZXJpb24gPT4ge1xuICAgICAgLy8gWFhYIGhhbmRsZSAkYWxsLyRlbGVtTWF0Y2ggY29tYmluYXRpb25cbiAgICAgIGlmIChpc09wZXJhdG9yT2JqZWN0KGNyaXRlcmlvbikpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ25vICQgZXhwcmVzc2lvbnMgaW4gJGFsbCcpO1xuICAgICAgfVxuXG4gICAgICAvLyBUaGlzIGlzIGFsd2F5cyBhIHJlZ2V4cCBvciBlcXVhbGl0eSBzZWxlY3Rvci5cbiAgICAgIHJldHVybiBjb21waWxlVmFsdWVTZWxlY3Rvcihjcml0ZXJpb24sIG1hdGNoZXIpO1xuICAgIH0pO1xuXG4gICAgLy8gYW5kQnJhbmNoZWRNYXRjaGVycyBkb2VzIE5PVCByZXF1aXJlIGFsbCBzZWxlY3RvcnMgdG8gcmV0dXJuIHRydWUgb24gdGhlXG4gICAgLy8gU0FNRSBicmFuY2guXG4gICAgcmV0dXJuIGFuZEJyYW5jaGVkTWF0Y2hlcnMoYnJhbmNoZWRNYXRjaGVycyk7XG4gIH0sXG4gICRuZWFyKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIsIGlzUm9vdCkge1xuICAgIGlmICghaXNSb290KSB7XG4gICAgICB0aHJvdyBFcnJvcignJG5lYXIgY2FuXFwndCBiZSBpbnNpZGUgYW5vdGhlciAkIG9wZXJhdG9yJyk7XG4gICAgfVxuXG4gICAgbWF0Y2hlci5faGFzR2VvUXVlcnkgPSB0cnVlO1xuXG4gICAgLy8gVGhlcmUgYXJlIHR3byBraW5kcyBvZiBnZW9kYXRhIGluIE1vbmdvREI6IGxlZ2FjeSBjb29yZGluYXRlIHBhaXJzIGFuZFxuICAgIC8vIEdlb0pTT04uIFRoZXkgdXNlIGRpZmZlcmVudCBkaXN0YW5jZSBtZXRyaWNzLCB0b28uIEdlb0pTT04gcXVlcmllcyBhcmVcbiAgICAvLyBtYXJrZWQgd2l0aCBhICRnZW9tZXRyeSBwcm9wZXJ0eSwgdGhvdWdoIGxlZ2FjeSBjb29yZGluYXRlcyBjYW4gYmVcbiAgICAvLyBtYXRjaGVkIHVzaW5nICRnZW9tZXRyeS5cbiAgICBsZXQgbWF4RGlzdGFuY2UsIHBvaW50LCBkaXN0YW5jZTtcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KG9wZXJhbmQpICYmIGhhc093bi5jYWxsKG9wZXJhbmQsICckZ2VvbWV0cnknKSkge1xuICAgICAgLy8gR2VvSlNPTiBcIjJkc3BoZXJlXCIgbW9kZS5cbiAgICAgIG1heERpc3RhbmNlID0gb3BlcmFuZC4kbWF4RGlzdGFuY2U7XG4gICAgICBwb2ludCA9IG9wZXJhbmQuJGdlb21ldHJ5O1xuICAgICAgZGlzdGFuY2UgPSB2YWx1ZSA9PiB7XG4gICAgICAgIC8vIFhYWDogZm9yIG5vdywgd2UgZG9uJ3QgY2FsY3VsYXRlIHRoZSBhY3R1YWwgZGlzdGFuY2UgYmV0d2Vlbiwgc2F5LFxuICAgICAgICAvLyBwb2x5Z29uIGFuZCBjaXJjbGUuIElmIHBlb3BsZSBjYXJlIGFib3V0IHRoaXMgdXNlLWNhc2UgaXQgd2lsbCBnZXRcbiAgICAgICAgLy8gYSBwcmlvcml0eS5cbiAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF2YWx1ZS50eXBlKSB7XG4gICAgICAgICAgcmV0dXJuIEdlb0pTT04ucG9pbnREaXN0YW5jZShcbiAgICAgICAgICAgIHBvaW50LFxuICAgICAgICAgICAge3R5cGU6ICdQb2ludCcsIGNvb3JkaW5hdGVzOiBwb2ludFRvQXJyYXkodmFsdWUpfVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUudHlwZSA9PT0gJ1BvaW50Jykge1xuICAgICAgICAgIHJldHVybiBHZW9KU09OLnBvaW50RGlzdGFuY2UocG9pbnQsIHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBHZW9KU09OLmdlb21ldHJ5V2l0aGluUmFkaXVzKHZhbHVlLCBwb2ludCwgbWF4RGlzdGFuY2UpXG4gICAgICAgICAgPyAwXG4gICAgICAgICAgOiBtYXhEaXN0YW5jZSArIDE7XG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBtYXhEaXN0YW5jZSA9IHZhbHVlU2VsZWN0b3IuJG1heERpc3RhbmNlO1xuXG4gICAgICBpZiAoIWlzSW5kZXhhYmxlKG9wZXJhbmQpKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckbmVhciBhcmd1bWVudCBtdXN0IGJlIGNvb3JkaW5hdGUgcGFpciBvciBHZW9KU09OJyk7XG4gICAgICB9XG5cbiAgICAgIHBvaW50ID0gcG9pbnRUb0FycmF5KG9wZXJhbmQpO1xuXG4gICAgICBkaXN0YW5jZSA9IHZhbHVlID0+IHtcbiAgICAgICAgaWYgKCFpc0luZGV4YWJsZSh2YWx1ZSkpIHtcbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyhwb2ludCwgdmFsdWUpO1xuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gYnJhbmNoZWRWYWx1ZXMgPT4ge1xuICAgICAgLy8gVGhlcmUgbWlnaHQgYmUgbXVsdGlwbGUgcG9pbnRzIGluIHRoZSBkb2N1bWVudCB0aGF0IG1hdGNoIHRoZSBnaXZlblxuICAgICAgLy8gZmllbGQuIE9ubHkgb25lIG9mIHRoZW0gbmVlZHMgdG8gYmUgd2l0aGluICRtYXhEaXN0YW5jZSwgYnV0IHdlIG5lZWQgdG9cbiAgICAgIC8vIGV2YWx1YXRlIGFsbCBvZiB0aGVtIGFuZCB1c2UgdGhlIG5lYXJlc3Qgb25lIGZvciB0aGUgaW1wbGljaXQgc29ydFxuICAgICAgLy8gc3BlY2lmaWVyLiAoVGhhdCdzIHdoeSB3ZSBjYW4ndCBqdXN0IHVzZSBFTEVNRU5UX09QRVJBVE9SUyBoZXJlLilcbiAgICAgIC8vXG4gICAgICAvLyBOb3RlOiBUaGlzIGRpZmZlcnMgZnJvbSBNb25nb0RCJ3MgaW1wbGVtZW50YXRpb24sIHdoZXJlIGEgZG9jdW1lbnQgd2lsbFxuICAgICAgLy8gYWN0dWFsbHkgc2hvdyB1cCAqbXVsdGlwbGUgdGltZXMqIGluIHRoZSByZXN1bHQgc2V0LCB3aXRoIG9uZSBlbnRyeSBmb3JcbiAgICAgIC8vIGVhY2ggd2l0aGluLSRtYXhEaXN0YW5jZSBicmFuY2hpbmcgcG9pbnQuXG4gICAgICBjb25zdCByZXN1bHQgPSB7cmVzdWx0OiBmYWxzZX07XG4gICAgICBleHBhbmRBcnJheXNJbkJyYW5jaGVzKGJyYW5jaGVkVmFsdWVzKS5ldmVyeShicmFuY2ggPT4ge1xuICAgICAgICAvLyBpZiBvcGVyYXRpb24gaXMgYW4gdXBkYXRlLCBkb24ndCBza2lwIGJyYW5jaGVzLCBqdXN0IHJldHVybiB0aGUgZmlyc3RcbiAgICAgICAgLy8gb25lICgjMzU5OSlcbiAgICAgICAgbGV0IGN1ckRpc3RhbmNlO1xuICAgICAgICBpZiAoIW1hdGNoZXIuX2lzVXBkYXRlKSB7XG4gICAgICAgICAgaWYgKCEodHlwZW9mIGJyYW5jaC52YWx1ZSA9PT0gJ29iamVjdCcpKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjdXJEaXN0YW5jZSA9IGRpc3RhbmNlKGJyYW5jaC52YWx1ZSk7XG5cbiAgICAgICAgICAvLyBTa2lwIGJyYW5jaGVzIHRoYXQgYXJlbid0IHJlYWwgcG9pbnRzIG9yIGFyZSB0b28gZmFyIGF3YXkuXG4gICAgICAgICAgaWYgKGN1ckRpc3RhbmNlID09PSBudWxsIHx8IGN1ckRpc3RhbmNlID4gbWF4RGlzdGFuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFNraXAgYW55dGhpbmcgdGhhdCdzIGEgdGllLlxuICAgICAgICAgIGlmIChyZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCAmJiByZXN1bHQuZGlzdGFuY2UgPD0gY3VyRGlzdGFuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5yZXN1bHQgPSB0cnVlO1xuICAgICAgICByZXN1bHQuZGlzdGFuY2UgPSBjdXJEaXN0YW5jZTtcblxuICAgICAgICBpZiAoYnJhbmNoLmFycmF5SW5kaWNlcykge1xuICAgICAgICAgIHJlc3VsdC5hcnJheUluZGljZXMgPSBicmFuY2guYXJyYXlJbmRpY2VzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRlbGV0ZSByZXN1bHQuYXJyYXlJbmRpY2VzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICFtYXRjaGVyLl9pc1VwZGF0ZTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG4gIH0sXG59O1xuXG4vLyBOQjogV2UgYXJlIGNoZWF0aW5nIGFuZCB1c2luZyB0aGlzIGZ1bmN0aW9uIHRvIGltcGxlbWVudCAnQU5EJyBmb3IgYm90aFxuLy8gJ2RvY3VtZW50IG1hdGNoZXJzJyBhbmQgJ2JyYW5jaGVkIG1hdGNoZXJzJy4gVGhleSBib3RoIHJldHVybiByZXN1bHQgb2JqZWN0c1xuLy8gYnV0IHRoZSBhcmd1bWVudCBpcyBkaWZmZXJlbnQ6IGZvciB0aGUgZm9ybWVyIGl0J3MgYSB3aG9sZSBkb2MsIHdoZXJlYXMgZm9yXG4vLyB0aGUgbGF0dGVyIGl0J3MgYW4gYXJyYXkgb2YgJ2JyYW5jaGVkIHZhbHVlcycuXG5mdW5jdGlvbiBhbmRTb21lTWF0Y2hlcnMoc3ViTWF0Y2hlcnMpIHtcbiAgaWYgKHN1Yk1hdGNoZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBldmVyeXRoaW5nTWF0Y2hlcjtcbiAgfVxuXG4gIGlmIChzdWJNYXRjaGVycy5sZW5ndGggPT09IDEpIHtcbiAgICByZXR1cm4gc3ViTWF0Y2hlcnNbMF07XG4gIH1cblxuICByZXR1cm4gZG9jT3JCcmFuY2hlcyA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSB7fTtcbiAgICBtYXRjaC5yZXN1bHQgPSBzdWJNYXRjaGVycy5ldmVyeShmbiA9PiB7XG4gICAgICBjb25zdCBzdWJSZXN1bHQgPSBmbihkb2NPckJyYW5jaGVzKTtcblxuICAgICAgLy8gQ29weSBhICdkaXN0YW5jZScgbnVtYmVyIG91dCBvZiB0aGUgZmlyc3Qgc3ViLW1hdGNoZXIgdGhhdCBoYXNcbiAgICAgIC8vIG9uZS4gWWVzLCB0aGlzIG1lYW5zIHRoYXQgaWYgdGhlcmUgYXJlIG11bHRpcGxlICRuZWFyIGZpZWxkcyBpbiBhXG4gICAgICAvLyBxdWVyeSwgc29tZXRoaW5nIGFyYml0cmFyeSBoYXBwZW5zOyB0aGlzIGFwcGVhcnMgdG8gYmUgY29uc2lzdGVudCB3aXRoXG4gICAgICAvLyBNb25nby5cbiAgICAgIGlmIChzdWJSZXN1bHQucmVzdWx0ICYmXG4gICAgICAgICAgc3ViUmVzdWx0LmRpc3RhbmNlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICBtYXRjaC5kaXN0YW5jZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG1hdGNoLmRpc3RhbmNlID0gc3ViUmVzdWx0LmRpc3RhbmNlO1xuICAgICAgfVxuXG4gICAgICAvLyBTaW1pbGFybHksIHByb3BhZ2F0ZSBhcnJheUluZGljZXMgZnJvbSBzdWItbWF0Y2hlcnMuLi4gYnV0IHRvIG1hdGNoXG4gICAgICAvLyBNb25nb0RCIGJlaGF2aW9yLCB0aGlzIHRpbWUgdGhlICpsYXN0KiBzdWItbWF0Y2hlciB3aXRoIGFycmF5SW5kaWNlc1xuICAgICAgLy8gd2lucy5cbiAgICAgIGlmIChzdWJSZXN1bHQucmVzdWx0ICYmIHN1YlJlc3VsdC5hcnJheUluZGljZXMpIHtcbiAgICAgICAgbWF0Y2guYXJyYXlJbmRpY2VzID0gc3ViUmVzdWx0LmFycmF5SW5kaWNlcztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHN1YlJlc3VsdC5yZXN1bHQ7XG4gICAgfSk7XG5cbiAgICAvLyBJZiB3ZSBkaWRuJ3QgYWN0dWFsbHkgbWF0Y2gsIGZvcmdldCBhbnkgZXh0cmEgbWV0YWRhdGEgd2UgY2FtZSB1cCB3aXRoLlxuICAgIGlmICghbWF0Y2gucmVzdWx0KSB7XG4gICAgICBkZWxldGUgbWF0Y2guZGlzdGFuY2U7XG4gICAgICBkZWxldGUgbWF0Y2guYXJyYXlJbmRpY2VzO1xuICAgIH1cblxuICAgIHJldHVybiBtYXRjaDtcbiAgfTtcbn1cblxuY29uc3QgYW5kRG9jdW1lbnRNYXRjaGVycyA9IGFuZFNvbWVNYXRjaGVycztcbmNvbnN0IGFuZEJyYW5jaGVkTWF0Y2hlcnMgPSBhbmRTb21lTWF0Y2hlcnM7XG5cbmZ1bmN0aW9uIGNvbXBpbGVBcnJheU9mRG9jdW1lbnRTZWxlY3RvcnMoc2VsZWN0b3JzLCBtYXRjaGVyLCBpbkVsZW1NYXRjaCkge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoc2VsZWN0b3JzKSB8fCBzZWxlY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgRXJyb3IoJyRhbmQvJG9yLyRub3IgbXVzdCBiZSBub25lbXB0eSBhcnJheScpO1xuICB9XG5cbiAgcmV0dXJuIHNlbGVjdG9ycy5tYXAoc3ViU2VsZWN0b3IgPT4ge1xuICAgIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KHN1YlNlbGVjdG9yKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRvci8kYW5kLyRub3IgZW50cmllcyBuZWVkIHRvIGJlIGZ1bGwgb2JqZWN0cycpO1xuICAgIH1cblxuICAgIHJldHVybiBjb21waWxlRG9jdW1lbnRTZWxlY3RvcihzdWJTZWxlY3RvciwgbWF0Y2hlciwge2luRWxlbU1hdGNofSk7XG4gIH0pO1xufVxuXG4vLyBUYWtlcyBpbiBhIHNlbGVjdG9yIHRoYXQgY291bGQgbWF0Y2ggYSBmdWxsIGRvY3VtZW50IChlZywgdGhlIG9yaWdpbmFsXG4vLyBzZWxlY3RvcikuIFJldHVybnMgYSBmdW5jdGlvbiBtYXBwaW5nIGRvY3VtZW50LT5yZXN1bHQgb2JqZWN0LlxuLy9cbi8vIG1hdGNoZXIgaXMgdGhlIE1hdGNoZXIgb2JqZWN0IHdlIGFyZSBjb21waWxpbmcuXG4vL1xuLy8gSWYgdGhpcyBpcyB0aGUgcm9vdCBkb2N1bWVudCBzZWxlY3RvciAoaWUsIG5vdCB3cmFwcGVkIGluICRhbmQgb3IgdGhlIGxpa2UpLFxuLy8gdGhlbiBpc1Jvb3QgaXMgdHJ1ZS4gKFRoaXMgaXMgdXNlZCBieSAkbmVhci4pXG5leHBvcnQgZnVuY3Rpb24gY29tcGlsZURvY3VtZW50U2VsZWN0b3IoZG9jU2VsZWN0b3IsIG1hdGNoZXIsIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCBkb2NNYXRjaGVycyA9IE9iamVjdC5rZXlzKGRvY1NlbGVjdG9yKS5tYXAoa2V5ID0+IHtcbiAgICBjb25zdCBzdWJTZWxlY3RvciA9IGRvY1NlbGVjdG9yW2tleV07XG5cbiAgICBpZiAoa2V5LnN1YnN0cigwLCAxKSA9PT0gJyQnKSB7XG4gICAgICAvLyBPdXRlciBvcGVyYXRvcnMgYXJlIGVpdGhlciBsb2dpY2FsIG9wZXJhdG9ycyAodGhleSByZWN1cnNlIGJhY2sgaW50b1xuICAgICAgLy8gdGhpcyBmdW5jdGlvbiksIG9yICR3aGVyZS5cbiAgICAgIGlmICghaGFzT3duLmNhbGwoTE9HSUNBTF9PUEVSQVRPUlMsIGtleSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnJlY29nbml6ZWQgbG9naWNhbCBvcGVyYXRvcjogJHtrZXl9YCk7XG4gICAgICB9XG5cbiAgICAgIG1hdGNoZXIuX2lzU2ltcGxlID0gZmFsc2U7XG4gICAgICByZXR1cm4gTE9HSUNBTF9PUEVSQVRPUlNba2V5XShzdWJTZWxlY3RvciwgbWF0Y2hlciwgb3B0aW9ucy5pbkVsZW1NYXRjaCk7XG4gICAgfVxuXG4gICAgLy8gUmVjb3JkIHRoaXMgcGF0aCwgYnV0IG9ubHkgaWYgd2UgYXJlbid0IGluIGFuIGVsZW1NYXRjaGVyLCBzaW5jZSBpbiBhblxuICAgIC8vIGVsZW1NYXRjaCB0aGlzIGlzIGEgcGF0aCBpbnNpZGUgYW4gb2JqZWN0IGluIGFuIGFycmF5LCBub3QgaW4gdGhlIGRvY1xuICAgIC8vIHJvb3QuXG4gICAgaWYgKCFvcHRpb25zLmluRWxlbU1hdGNoKSB7XG4gICAgICBtYXRjaGVyLl9yZWNvcmRQYXRoVXNlZChrZXkpO1xuICAgIH1cblxuICAgIC8vIERvbid0IGFkZCBhIG1hdGNoZXIgaWYgc3ViU2VsZWN0b3IgaXMgYSBmdW5jdGlvbiAtLSB0aGlzIGlzIHRvIG1hdGNoXG4gICAgLy8gdGhlIGJlaGF2aW9yIG9mIE1ldGVvciBvbiB0aGUgc2VydmVyIChpbmhlcml0ZWQgZnJvbSB0aGUgbm9kZSBtb25nb2RiXG4gICAgLy8gZHJpdmVyKSwgd2hpY2ggaXMgdG8gaWdub3JlIGFueSBwYXJ0IG9mIGEgc2VsZWN0b3Igd2hpY2ggaXMgYSBmdW5jdGlvbi5cbiAgICBpZiAodHlwZW9mIHN1YlNlbGVjdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnN0IGxvb2tVcEJ5SW5kZXggPSBtYWtlTG9va3VwRnVuY3Rpb24oa2V5KTtcbiAgICBjb25zdCB2YWx1ZU1hdGNoZXIgPSBjb21waWxlVmFsdWVTZWxlY3RvcihcbiAgICAgIHN1YlNlbGVjdG9yLFxuICAgICAgbWF0Y2hlcixcbiAgICAgIG9wdGlvbnMuaXNSb290XG4gICAgKTtcblxuICAgIHJldHVybiBkb2MgPT4gdmFsdWVNYXRjaGVyKGxvb2tVcEJ5SW5kZXgoZG9jKSk7XG4gIH0pLmZpbHRlcihCb29sZWFuKTtcblxuICByZXR1cm4gYW5kRG9jdW1lbnRNYXRjaGVycyhkb2NNYXRjaGVycyk7XG59XG5cbi8vIFRha2VzIGluIGEgc2VsZWN0b3IgdGhhdCBjb3VsZCBtYXRjaCBhIGtleS1pbmRleGVkIHZhbHVlIGluIGEgZG9jdW1lbnQ7IGVnLFxuLy8geyRndDogNSwgJGx0OiA5fSwgb3IgYSByZWd1bGFyIGV4cHJlc3Npb24sIG9yIGFueSBub24tZXhwcmVzc2lvbiBvYmplY3QgKHRvXG4vLyBpbmRpY2F0ZSBlcXVhbGl0eSkuICBSZXR1cm5zIGEgYnJhbmNoZWQgbWF0Y2hlcjogYSBmdW5jdGlvbiBtYXBwaW5nXG4vLyBbYnJhbmNoZWQgdmFsdWVdLT5yZXN1bHQgb2JqZWN0LlxuZnVuY3Rpb24gY29tcGlsZVZhbHVlU2VsZWN0b3IodmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KSB7XG4gIGlmICh2YWx1ZVNlbGVjdG9yIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgbWF0Y2hlci5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICByZWdleHBFbGVtZW50TWF0Y2hlcih2YWx1ZVNlbGVjdG9yKVxuICAgICk7XG4gIH1cblxuICBpZiAoaXNPcGVyYXRvck9iamVjdCh2YWx1ZVNlbGVjdG9yKSkge1xuICAgIHJldHVybiBvcGVyYXRvckJyYW5jaGVkTWF0Y2hlcih2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyLCBpc1Jvb3QpO1xuICB9XG5cbiAgcmV0dXJuIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIodmFsdWVTZWxlY3RvcilcbiAgKTtcbn1cblxuLy8gR2l2ZW4gYW4gZWxlbWVudCBtYXRjaGVyICh3aGljaCBldmFsdWF0ZXMgYSBzaW5nbGUgdmFsdWUpLCByZXR1cm5zIGEgYnJhbmNoZWRcbi8vIHZhbHVlICh3aGljaCBldmFsdWF0ZXMgdGhlIGVsZW1lbnQgbWF0Y2hlciBvbiBhbGwgdGhlIGJyYW5jaGVzIGFuZCByZXR1cm5zIGFcbi8vIG1vcmUgc3RydWN0dXJlZCByZXR1cm4gdmFsdWUgcG9zc2libHkgaW5jbHVkaW5nIGFycmF5SW5kaWNlcykuXG5mdW5jdGlvbiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihlbGVtZW50TWF0Y2hlciwgb3B0aW9ucyA9IHt9KSB7XG4gIHJldHVybiBicmFuY2hlcyA9PiB7XG4gICAgY29uc3QgZXhwYW5kZWQgPSBvcHRpb25zLmRvbnRFeHBhbmRMZWFmQXJyYXlzXG4gICAgICA/IGJyYW5jaGVzXG4gICAgICA6IGV4cGFuZEFycmF5c0luQnJhbmNoZXMoYnJhbmNoZXMsIG9wdGlvbnMuZG9udEluY2x1ZGVMZWFmQXJyYXlzKTtcblxuICAgIGNvbnN0IG1hdGNoID0ge307XG4gICAgbWF0Y2gucmVzdWx0ID0gZXhwYW5kZWQuc29tZShlbGVtZW50ID0+IHtcbiAgICAgIGxldCBtYXRjaGVkID0gZWxlbWVudE1hdGNoZXIoZWxlbWVudC52YWx1ZSk7XG5cbiAgICAgIC8vIFNwZWNpYWwgY2FzZSBmb3IgJGVsZW1NYXRjaDogaXQgbWVhbnMgXCJ0cnVlLCBhbmQgdXNlIHRoaXMgYXMgYW4gYXJyYXlcbiAgICAgIC8vIGluZGV4IGlmIEkgZGlkbid0IGFscmVhZHkgaGF2ZSBvbmVcIi5cbiAgICAgIGlmICh0eXBlb2YgbWF0Y2hlZCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgLy8gWFhYIFRoaXMgY29kZSBkYXRlcyBmcm9tIHdoZW4gd2Ugb25seSBzdG9yZWQgYSBzaW5nbGUgYXJyYXkgaW5kZXhcbiAgICAgICAgLy8gKGZvciB0aGUgb3V0ZXJtb3N0IGFycmF5KS4gU2hvdWxkIHdlIGJlIGFsc28gaW5jbHVkaW5nIGRlZXBlciBhcnJheVxuICAgICAgICAvLyBpbmRpY2VzIGZyb20gdGhlICRlbGVtTWF0Y2ggbWF0Y2g/XG4gICAgICAgIGlmICghZWxlbWVudC5hcnJheUluZGljZXMpIHtcbiAgICAgICAgICBlbGVtZW50LmFycmF5SW5kaWNlcyA9IFttYXRjaGVkXTtcbiAgICAgICAgfVxuXG4gICAgICAgIG1hdGNoZWQgPSB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBJZiBzb21lIGVsZW1lbnQgbWF0Y2hlZCwgYW5kIGl0J3MgdGFnZ2VkIHdpdGggYXJyYXkgaW5kaWNlcywgaW5jbHVkZVxuICAgICAgLy8gdGhvc2UgaW5kaWNlcyBpbiBvdXIgcmVzdWx0IG9iamVjdC5cbiAgICAgIGlmIChtYXRjaGVkICYmIGVsZW1lbnQuYXJyYXlJbmRpY2VzKSB7XG4gICAgICAgIG1hdGNoLmFycmF5SW5kaWNlcyA9IGVsZW1lbnQuYXJyYXlJbmRpY2VzO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbWF0Y2hlZDtcbiAgICB9KTtcblxuICAgIHJldHVybiBtYXRjaDtcbiAgfTtcbn1cblxuLy8gSGVscGVycyBmb3IgJG5lYXIuXG5mdW5jdGlvbiBkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyhhLCBiKSB7XG4gIGNvbnN0IHBvaW50QSA9IHBvaW50VG9BcnJheShhKTtcbiAgY29uc3QgcG9pbnRCID0gcG9pbnRUb0FycmF5KGIpO1xuXG4gIHJldHVybiBNYXRoLmh5cG90KHBvaW50QVswXSAtIHBvaW50QlswXSwgcG9pbnRBWzFdIC0gcG9pbnRCWzFdKTtcbn1cblxuLy8gVGFrZXMgc29tZXRoaW5nIHRoYXQgaXMgbm90IGFuIG9wZXJhdG9yIG9iamVjdCBhbmQgcmV0dXJucyBhbiBlbGVtZW50IG1hdGNoZXJcbi8vIGZvciBlcXVhbGl0eSB3aXRoIHRoYXQgdGhpbmcuXG5leHBvcnQgZnVuY3Rpb24gZXF1YWxpdHlFbGVtZW50TWF0Y2hlcihlbGVtZW50U2VsZWN0b3IpIHtcbiAgaWYgKGlzT3BlcmF0b3JPYmplY3QoZWxlbWVudFNlbGVjdG9yKSkge1xuICAgIHRocm93IEVycm9yKCdDYW5cXCd0IGNyZWF0ZSBlcXVhbGl0eVZhbHVlU2VsZWN0b3IgZm9yIG9wZXJhdG9yIG9iamVjdCcpO1xuICB9XG5cbiAgLy8gU3BlY2lhbC1jYXNlOiBudWxsIGFuZCB1bmRlZmluZWQgYXJlIGVxdWFsIChpZiB5b3UgZ290IHVuZGVmaW5lZCBpbiB0aGVyZVxuICAvLyBzb21ld2hlcmUsIG9yIGlmIHlvdSBnb3QgaXQgZHVlIHRvIHNvbWUgYnJhbmNoIGJlaW5nIG5vbi1leGlzdGVudCBpbiB0aGVcbiAgLy8gd2VpcmQgc3BlY2lhbCBjYXNlKSwgZXZlbiB0aG91Z2ggdGhleSBhcmVuJ3Qgd2l0aCBFSlNPTi5lcXVhbHMuXG4gIC8vIHVuZGVmaW5lZCBvciBudWxsXG4gIGlmIChlbGVtZW50U2VsZWN0b3IgPT0gbnVsbCkge1xuICAgIHJldHVybiB2YWx1ZSA9PiB2YWx1ZSA9PSBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHZhbHVlID0+IExvY2FsQ29sbGVjdGlvbi5fZi5fZXF1YWwoZWxlbWVudFNlbGVjdG9yLCB2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGV2ZXJ5dGhpbmdNYXRjaGVyKGRvY09yQnJhbmNoZWRWYWx1ZXMpIHtcbiAgcmV0dXJuIHtyZXN1bHQ6IHRydWV9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyhicmFuY2hlcywgc2tpcFRoZUFycmF5cykge1xuICBjb25zdCBicmFuY2hlc091dCA9IFtdO1xuXG4gIGJyYW5jaGVzLmZvckVhY2goYnJhbmNoID0+IHtcbiAgICBjb25zdCB0aGlzSXNBcnJheSA9IEFycmF5LmlzQXJyYXkoYnJhbmNoLnZhbHVlKTtcblxuICAgIC8vIFdlIGluY2x1ZGUgdGhlIGJyYW5jaCBpdHNlbGYsICpVTkxFU1MqIHdlIGl0J3MgYW4gYXJyYXkgdGhhdCB3ZSdyZSBnb2luZ1xuICAgIC8vIHRvIGl0ZXJhdGUgYW5kIHdlJ3JlIHRvbGQgdG8gc2tpcCBhcnJheXMuICAoVGhhdCdzIHJpZ2h0LCB3ZSBpbmNsdWRlIHNvbWVcbiAgICAvLyBhcnJheXMgZXZlbiBza2lwVGhlQXJyYXlzIGlzIHRydWU6IHRoZXNlIGFyZSBhcnJheXMgdGhhdCB3ZXJlIGZvdW5kIHZpYVxuICAgIC8vIGV4cGxpY2l0IG51bWVyaWNhbCBpbmRpY2VzLilcbiAgICBpZiAoIShza2lwVGhlQXJyYXlzICYmIHRoaXNJc0FycmF5ICYmICFicmFuY2guZG9udEl0ZXJhdGUpKSB7XG4gICAgICBicmFuY2hlc091dC5wdXNoKHthcnJheUluZGljZXM6IGJyYW5jaC5hcnJheUluZGljZXMsIHZhbHVlOiBicmFuY2gudmFsdWV9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpc0lzQXJyYXkgJiYgIWJyYW5jaC5kb250SXRlcmF0ZSkge1xuICAgICAgYnJhbmNoLnZhbHVlLmZvckVhY2goKHZhbHVlLCBpKSA9PiB7XG4gICAgICAgIGJyYW5jaGVzT3V0LnB1c2goe1xuICAgICAgICAgIGFycmF5SW5kaWNlczogKGJyYW5jaC5hcnJheUluZGljZXMgfHwgW10pLmNvbmNhdChpKSxcbiAgICAgICAgICB2YWx1ZVxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIGJyYW5jaGVzT3V0O1xufVxuXG4vLyBIZWxwZXJzIGZvciAkYml0c0FsbFNldC8kYml0c0FueVNldC8kYml0c0FsbENsZWFyLyRiaXRzQW55Q2xlYXIuXG5mdW5jdGlvbiBnZXRPcGVyYW5kQml0bWFzayhvcGVyYW5kLCBzZWxlY3Rvcikge1xuICAvLyBudW1lcmljIGJpdG1hc2tcbiAgLy8gWW91IGNhbiBwcm92aWRlIGEgbnVtZXJpYyBiaXRtYXNrIHRvIGJlIG1hdGNoZWQgYWdhaW5zdCB0aGUgb3BlcmFuZCBmaWVsZC5cbiAgLy8gSXQgbXVzdCBiZSByZXByZXNlbnRhYmxlIGFzIGEgbm9uLW5lZ2F0aXZlIDMyLWJpdCBzaWduZWQgaW50ZWdlci5cbiAgLy8gT3RoZXJ3aXNlLCAkYml0c0FsbFNldCB3aWxsIHJldHVybiBhbiBlcnJvci5cbiAgaWYgKE51bWJlci5pc0ludGVnZXIob3BlcmFuZCkgJiYgb3BlcmFuZCA+PSAwKSB7XG4gICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KG5ldyBJbnQzMkFycmF5KFtvcGVyYW5kXSkuYnVmZmVyKTtcbiAgfVxuXG4gIC8vIGJpbmRhdGEgYml0bWFza1xuICAvLyBZb3UgY2FuIGFsc28gdXNlIGFuIGFyYml0cmFyaWx5IGxhcmdlIEJpbkRhdGEgaW5zdGFuY2UgYXMgYSBiaXRtYXNrLlxuICBpZiAoRUpTT04uaXNCaW5hcnkob3BlcmFuZCkpIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkob3BlcmFuZC5idWZmZXIpO1xuICB9XG5cbiAgLy8gcG9zaXRpb24gbGlzdFxuICAvLyBJZiBxdWVyeWluZyBhIGxpc3Qgb2YgYml0IHBvc2l0aW9ucywgZWFjaCA8cG9zaXRpb24+IG11c3QgYmUgYSBub24tbmVnYXRpdmVcbiAgLy8gaW50ZWdlci4gQml0IHBvc2l0aW9ucyBzdGFydCBhdCAwIGZyb20gdGhlIGxlYXN0IHNpZ25pZmljYW50IGJpdC5cbiAgaWYgKEFycmF5LmlzQXJyYXkob3BlcmFuZCkgJiZcbiAgICAgIG9wZXJhbmQuZXZlcnkoeCA9PiBOdW1iZXIuaXNJbnRlZ2VyKHgpICYmIHggPj0gMCkpIHtcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoKE1hdGgubWF4KC4uLm9wZXJhbmQpID4+IDMpICsgMSk7XG4gICAgY29uc3QgdmlldyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7XG5cbiAgICBvcGVyYW5kLmZvckVhY2goeCA9PiB7XG4gICAgICB2aWV3W3ggPj4gM10gfD0gMSA8PCAoeCAmIDB4Nyk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdmlldztcbiAgfVxuXG4gIC8vIGJhZCBvcGVyYW5kXG4gIHRocm93IEVycm9yKFxuICAgIGBvcGVyYW5kIHRvICR7c2VsZWN0b3J9IG11c3QgYmUgYSBudW1lcmljIGJpdG1hc2sgKHJlcHJlc2VudGFibGUgYXMgYSBgICtcbiAgICAnbm9uLW5lZ2F0aXZlIDMyLWJpdCBzaWduZWQgaW50ZWdlciksIGEgYmluZGF0YSBiaXRtYXNrIG9yIGFuIGFycmF5IHdpdGggJyArXG4gICAgJ2JpdCBwb3NpdGlvbnMgKG5vbi1uZWdhdGl2ZSBpbnRlZ2VycyknXG4gICk7XG59XG5cbmZ1bmN0aW9uIGdldFZhbHVlQml0bWFzayh2YWx1ZSwgbGVuZ3RoKSB7XG4gIC8vIFRoZSBmaWVsZCB2YWx1ZSBtdXN0IGJlIGVpdGhlciBudW1lcmljYWwgb3IgYSBCaW5EYXRhIGluc3RhbmNlLiBPdGhlcndpc2UsXG4gIC8vICRiaXRzLi4uIHdpbGwgbm90IG1hdGNoIHRoZSBjdXJyZW50IGRvY3VtZW50LlxuXG4gIC8vIG51bWVyaWNhbFxuICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpKSB7XG4gICAgLy8gJGJpdHMuLi4gd2lsbCBub3QgbWF0Y2ggbnVtZXJpY2FsIHZhbHVlcyB0aGF0IGNhbm5vdCBiZSByZXByZXNlbnRlZCBhcyBhXG4gICAgLy8gc2lnbmVkIDY0LWJpdCBpbnRlZ2VyLiBUaGlzIGNhbiBiZSB0aGUgY2FzZSBpZiBhIHZhbHVlIGlzIGVpdGhlciB0b29cbiAgICAvLyBsYXJnZSBvciBzbWFsbCB0byBmaXQgaW4gYSBzaWduZWQgNjQtYml0IGludGVnZXIsIG9yIGlmIGl0IGhhcyBhXG4gICAgLy8gZnJhY3Rpb25hbCBjb21wb25lbnQuXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKFxuICAgICAgTWF0aC5tYXgobGVuZ3RoLCAyICogVWludDMyQXJyYXkuQllURVNfUEVSX0VMRU1FTlQpXG4gICAgKTtcblxuICAgIGxldCB2aWV3ID0gbmV3IFVpbnQzMkFycmF5KGJ1ZmZlciwgMCwgMik7XG4gICAgdmlld1swXSA9IHZhbHVlICUgKCgxIDw8IDE2KSAqICgxIDw8IDE2KSkgfCAwO1xuICAgIHZpZXdbMV0gPSB2YWx1ZSAvICgoMSA8PCAxNikgKiAoMSA8PCAxNikpIHwgMDtcblxuICAgIC8vIHNpZ24gZXh0ZW5zaW9uXG4gICAgaWYgKHZhbHVlIDwgMCkge1xuICAgICAgdmlldyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlciwgMik7XG4gICAgICB2aWV3LmZvckVhY2goKGJ5dGUsIGkpID0+IHtcbiAgICAgICAgdmlld1tpXSA9IDB4ZmY7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKTtcbiAgfVxuXG4gIC8vIGJpbmRhdGFcbiAgaWYgKEVKU09OLmlzQmluYXJ5KHZhbHVlKSkge1xuICAgIHJldHVybiBuZXcgVWludDhBcnJheSh2YWx1ZS5idWZmZXIpO1xuICB9XG5cbiAgLy8gbm8gbWF0Y2hcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyBBY3R1YWxseSBpbnNlcnRzIGEga2V5IHZhbHVlIGludG8gdGhlIHNlbGVjdG9yIGRvY3VtZW50XG4vLyBIb3dldmVyLCB0aGlzIGNoZWNrcyB0aGVyZSBpcyBubyBhbWJpZ3VpdHkgaW4gc2V0dGluZ1xuLy8gdGhlIHZhbHVlIGZvciB0aGUgZ2l2ZW4ga2V5LCB0aHJvd3Mgb3RoZXJ3aXNlXG5mdW5jdGlvbiBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgT2JqZWN0LmtleXMoZG9jdW1lbnQpLmZvckVhY2goZXhpc3RpbmdLZXkgPT4ge1xuICAgIGlmIChcbiAgICAgIChleGlzdGluZ0tleS5sZW5ndGggPiBrZXkubGVuZ3RoICYmIGV4aXN0aW5nS2V5LmluZGV4T2YoYCR7a2V5fS5gKSA9PT0gMCkgfHxcbiAgICAgIChrZXkubGVuZ3RoID4gZXhpc3RpbmdLZXkubGVuZ3RoICYmIGtleS5pbmRleE9mKGAke2V4aXN0aW5nS2V5fS5gKSA9PT0gMClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYGNhbm5vdCBpbmZlciBxdWVyeSBmaWVsZHMgdG8gc2V0LCBib3RoIHBhdGhzICcke2V4aXN0aW5nS2V5fScgYW5kIGAgK1xuICAgICAgICBgJyR7a2V5fScgYXJlIG1hdGNoZWRgXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZXhpc3RpbmdLZXkgPT09IGtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgY2Fubm90IGluZmVyIHF1ZXJ5IGZpZWxkcyB0byBzZXQsIHBhdGggJyR7a2V5fScgaXMgbWF0Y2hlZCB0d2ljZWBcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBkb2N1bWVudFtrZXldID0gdmFsdWU7XG59XG5cbi8vIFJldHVybnMgYSBicmFuY2hlZCBtYXRjaGVyIHRoYXQgbWF0Y2hlcyBpZmYgdGhlIGdpdmVuIG1hdGNoZXIgZG9lcyBub3QuXG4vLyBOb3RlIHRoYXQgdGhpcyBpbXBsaWNpdGx5IFwiZGVNb3JnYW5pemVzXCIgdGhlIHdyYXBwZWQgZnVuY3Rpb24uICBpZSwgaXRcbi8vIG1lYW5zIHRoYXQgQUxMIGJyYW5jaCB2YWx1ZXMgbmVlZCB0byBmYWlsIHRvIG1hdGNoIGlubmVyQnJhbmNoZWRNYXRjaGVyLlxuZnVuY3Rpb24gaW52ZXJ0QnJhbmNoZWRNYXRjaGVyKGJyYW5jaGVkTWF0Y2hlcikge1xuICByZXR1cm4gYnJhbmNoVmFsdWVzID0+IHtcbiAgICAvLyBXZSBleHBsaWNpdGx5IGNob29zZSB0byBzdHJpcCBhcnJheUluZGljZXMgaGVyZTogaXQgZG9lc24ndCBtYWtlIHNlbnNlIHRvXG4gICAgLy8gc2F5IFwidXBkYXRlIHRoZSBhcnJheSBlbGVtZW50IHRoYXQgZG9lcyBub3QgbWF0Y2ggc29tZXRoaW5nXCIsIGF0IGxlYXN0XG4gICAgLy8gaW4gbW9uZ28tbGFuZC5cbiAgICByZXR1cm4ge3Jlc3VsdDogIWJyYW5jaGVkTWF0Y2hlcihicmFuY2hWYWx1ZXMpLnJlc3VsdH07XG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0luZGV4YWJsZShvYmopIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkob2JqKSB8fCBMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3Qob2JqKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzTnVtZXJpY0tleShzKSB7XG4gIHJldHVybiAvXlswLTldKyQvLnRlc3Qocyk7XG59XG5cbi8vIFJldHVybnMgdHJ1ZSBpZiB0aGlzIGlzIGFuIG9iamVjdCB3aXRoIGF0IGxlYXN0IG9uZSBrZXkgYW5kIGFsbCBrZXlzIGJlZ2luXG4vLyB3aXRoICQuICBVbmxlc3MgaW5jb25zaXN0ZW50T0sgaXMgc2V0LCB0aHJvd3MgaWYgc29tZSBrZXlzIGJlZ2luIHdpdGggJCBhbmRcbi8vIG90aGVycyBkb24ndC5cbmV4cG9ydCBmdW5jdGlvbiBpc09wZXJhdG9yT2JqZWN0KHZhbHVlU2VsZWN0b3IsIGluY29uc2lzdGVudE9LKSB7XG4gIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KHZhbHVlU2VsZWN0b3IpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgbGV0IHRoZXNlQXJlT3BlcmF0b3JzID0gdW5kZWZpbmVkO1xuICBPYmplY3Qua2V5cyh2YWx1ZVNlbGVjdG9yKS5mb3JFYWNoKHNlbEtleSA9PiB7XG4gICAgY29uc3QgdGhpc0lzT3BlcmF0b3IgPSBzZWxLZXkuc3Vic3RyKDAsIDEpID09PSAnJCcgfHwgc2VsS2V5ID09PSAnZGlmZic7XG5cbiAgICBpZiAodGhlc2VBcmVPcGVyYXRvcnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhlc2VBcmVPcGVyYXRvcnMgPSB0aGlzSXNPcGVyYXRvcjtcbiAgICB9IGVsc2UgaWYgKHRoZXNlQXJlT3BlcmF0b3JzICE9PSB0aGlzSXNPcGVyYXRvcikge1xuICAgICAgaWYgKCFpbmNvbnNpc3RlbnRPSykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEluY29uc2lzdGVudCBvcGVyYXRvcjogJHtKU09OLnN0cmluZ2lmeSh2YWx1ZVNlbGVjdG9yKX1gXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHRoZXNlQXJlT3BlcmF0b3JzID0gZmFsc2U7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gISF0aGVzZUFyZU9wZXJhdG9yczsgLy8ge30gaGFzIG5vIG9wZXJhdG9yc1xufVxuXG4vLyBIZWxwZXIgZm9yICRsdC8kZ3QvJGx0ZS8kZ3RlLlxuZnVuY3Rpb24gbWFrZUluZXF1YWxpdHkoY21wVmFsdWVDb21wYXJhdG9yKSB7XG4gIHJldHVybiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICAvLyBBcnJheXMgbmV2ZXIgY29tcGFyZSBmYWxzZSB3aXRoIG5vbi1hcnJheXMgZm9yIGFueSBpbmVxdWFsaXR5LlxuICAgICAgLy8gWFhYIFRoaXMgd2FzIGJlaGF2aW9yIHdlIG9ic2VydmVkIGluIHByZS1yZWxlYXNlIE1vbmdvREIgMi41LCBidXRcbiAgICAgIC8vICAgICBpdCBzZWVtcyB0byBoYXZlIGJlZW4gcmV2ZXJ0ZWQuXG4gICAgICAvLyAgICAgU2VlIGh0dHBzOi8vamlyYS5tb25nb2RiLm9yZy9icm93c2UvU0VSVkVSLTExNDQ0XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgICByZXR1cm4gKCkgPT4gZmFsc2U7XG4gICAgICB9XG5cbiAgICAgIC8vIFNwZWNpYWwgY2FzZTogY29uc2lkZXIgdW5kZWZpbmVkIGFuZCBudWxsIHRoZSBzYW1lIChzbyB0cnVlIHdpdGhcbiAgICAgIC8vICRndGUvJGx0ZSkuXG4gICAgICBpZiAob3BlcmFuZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG9wZXJhbmQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBvcGVyYW5kVHlwZSA9IExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZShvcGVyYW5kKTtcblxuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB2YWx1ZSA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDb21wYXJpc29ucyBhcmUgbmV2ZXIgdHJ1ZSBhbW9uZyB0aGluZ3Mgb2YgZGlmZmVyZW50IHR5cGUgKGV4Y2VwdFxuICAgICAgICAvLyBudWxsIHZzIHVuZGVmaW5lZCkuXG4gICAgICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUodmFsdWUpICE9PSBvcGVyYW5kVHlwZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjbXBWYWx1ZUNvbXBhcmF0b3IoTG9jYWxDb2xsZWN0aW9uLl9mLl9jbXAodmFsdWUsIG9wZXJhbmQpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cblxuLy8gbWFrZUxvb2t1cEZ1bmN0aW9uKGtleSkgcmV0dXJucyBhIGxvb2t1cCBmdW5jdGlvbi5cbi8vXG4vLyBBIGxvb2t1cCBmdW5jdGlvbiB0YWtlcyBpbiBhIGRvY3VtZW50IGFuZCByZXR1cm5zIGFuIGFycmF5IG9mIG1hdGNoaW5nXG4vLyBicmFuY2hlcy4gIElmIG5vIGFycmF5cyBhcmUgZm91bmQgd2hpbGUgbG9va2luZyB1cCB0aGUga2V5LCB0aGlzIGFycmF5IHdpbGxcbi8vIGhhdmUgZXhhY3RseSBvbmUgYnJhbmNoZXMgKHBvc3NpYmx5ICd1bmRlZmluZWQnLCBpZiBzb21lIHNlZ21lbnQgb2YgdGhlIGtleVxuLy8gd2FzIG5vdCBmb3VuZCkuXG4vL1xuLy8gSWYgYXJyYXlzIGFyZSBmb3VuZCBpbiB0aGUgbWlkZGxlLCB0aGlzIGNhbiBoYXZlIG1vcmUgdGhhbiBvbmUgZWxlbWVudCwgc2luY2Vcbi8vIHdlICdicmFuY2gnLiBXaGVuIHdlICdicmFuY2gnLCBpZiB0aGVyZSBhcmUgbW9yZSBrZXkgc2VnbWVudHMgdG8gbG9vayB1cCxcbi8vIHRoZW4gd2Ugb25seSBwdXJzdWUgYnJhbmNoZXMgdGhhdCBhcmUgcGxhaW4gb2JqZWN0cyAobm90IGFycmF5cyBvciBzY2FsYXJzKS5cbi8vIFRoaXMgbWVhbnMgd2UgY2FuIGFjdHVhbGx5IGVuZCB1cCB3aXRoIG5vIGJyYW5jaGVzIVxuLy9cbi8vIFdlIGRvICpOT1QqIGJyYW5jaCBvbiBhcnJheXMgdGhhdCBhcmUgZm91bmQgYXQgdGhlIGVuZCAoaWUsIGF0IHRoZSBsYXN0XG4vLyBkb3R0ZWQgbWVtYmVyIG9mIHRoZSBrZXkpLiBXZSBqdXN0IHJldHVybiB0aGF0IGFycmF5OyBpZiB5b3Ugd2FudCB0b1xuLy8gZWZmZWN0aXZlbHkgJ2JyYW5jaCcgb3ZlciB0aGUgYXJyYXkncyB2YWx1ZXMsIHBvc3QtcHJvY2VzcyB0aGUgbG9va3VwXG4vLyBmdW5jdGlvbiB3aXRoIGV4cGFuZEFycmF5c0luQnJhbmNoZXMuXG4vL1xuLy8gRWFjaCBicmFuY2ggaXMgYW4gb2JqZWN0IHdpdGgga2V5czpcbi8vICAtIHZhbHVlOiB0aGUgdmFsdWUgYXQgdGhlIGJyYW5jaFxuLy8gIC0gZG9udEl0ZXJhdGU6IGFuIG9wdGlvbmFsIGJvb2w7IGlmIHRydWUsIGl0IG1lYW5zIHRoYXQgJ3ZhbHVlJyBpcyBhbiBhcnJheVxuLy8gICAgdGhhdCBleHBhbmRBcnJheXNJbkJyYW5jaGVzIHNob3VsZCBOT1QgZXhwYW5kLiBUaGlzIHNwZWNpZmljYWxseSBoYXBwZW5zXG4vLyAgICB3aGVuIHRoZXJlIGlzIGEgbnVtZXJpYyBpbmRleCBpbiB0aGUga2V5LCBhbmQgZW5zdXJlcyB0aGVcbi8vICAgIHBlcmhhcHMtc3VycHJpc2luZyBNb25nb0RCIGJlaGF2aW9yIHdoZXJlIHsnYS4wJzogNX0gZG9lcyBOT1Rcbi8vICAgIG1hdGNoIHthOiBbWzVdXX0uXG4vLyAgLSBhcnJheUluZGljZXM6IGlmIGFueSBhcnJheSBpbmRleGluZyB3YXMgZG9uZSBkdXJpbmcgbG9va3VwIChlaXRoZXIgZHVlIHRvXG4vLyAgICBleHBsaWNpdCBudW1lcmljIGluZGljZXMgb3IgaW1wbGljaXQgYnJhbmNoaW5nKSwgdGhpcyB3aWxsIGJlIGFuIGFycmF5IG9mXG4vLyAgICB0aGUgYXJyYXkgaW5kaWNlcyB1c2VkLCBmcm9tIG91dGVybW9zdCB0byBpbm5lcm1vc3Q7IGl0IGlzIGZhbHNleSBvclxuLy8gICAgYWJzZW50IGlmIG5vIGFycmF5IGluZGV4IGlzIHVzZWQuIElmIGFuIGV4cGxpY2l0IG51bWVyaWMgaW5kZXggaXMgdXNlZCxcbi8vICAgIHRoZSBpbmRleCB3aWxsIGJlIGZvbGxvd2VkIGluIGFycmF5SW5kaWNlcyBieSB0aGUgc3RyaW5nICd4Jy5cbi8vXG4vLyAgICBOb3RlOiBhcnJheUluZGljZXMgaXMgdXNlZCBmb3IgdHdvIHB1cnBvc2VzLiBGaXJzdCwgaXQgaXMgdXNlZCB0b1xuLy8gICAgaW1wbGVtZW50IHRoZSAnJCcgbW9kaWZpZXIgZmVhdHVyZSwgd2hpY2ggb25seSBldmVyIGxvb2tzIGF0IGl0cyBmaXJzdFxuLy8gICAgZWxlbWVudC5cbi8vXG4vLyAgICBTZWNvbmQsIGl0IGlzIHVzZWQgZm9yIHNvcnQga2V5IGdlbmVyYXRpb24sIHdoaWNoIG5lZWRzIHRvIGJlIGFibGUgdG8gdGVsbFxuLy8gICAgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBkaWZmZXJlbnQgcGF0aHMuIE1vcmVvdmVyLCBpdCBuZWVkcyB0b1xuLy8gICAgZGlmZmVyZW50aWF0ZSBiZXR3ZWVuIGV4cGxpY2l0IGFuZCBpbXBsaWNpdCBicmFuY2hpbmcsIHdoaWNoIGlzIHdoeVxuLy8gICAgdGhlcmUncyB0aGUgc29tZXdoYXQgaGFja3kgJ3gnIGVudHJ5OiB0aGlzIG1lYW5zIHRoYXQgZXhwbGljaXQgYW5kXG4vLyAgICBpbXBsaWNpdCBhcnJheSBsb29rdXBzIHdpbGwgaGF2ZSBkaWZmZXJlbnQgZnVsbCBhcnJheUluZGljZXMgcGF0aHMuIChUaGF0XG4vLyAgICBjb2RlIG9ubHkgcmVxdWlyZXMgdGhhdCBkaWZmZXJlbnQgcGF0aHMgaGF2ZSBkaWZmZXJlbnQgYXJyYXlJbmRpY2VzOyBpdFxuLy8gICAgZG9lc24ndCBhY3R1YWxseSAncGFyc2UnIGFycmF5SW5kaWNlcy4gQXMgYW4gYWx0ZXJuYXRpdmUsIGFycmF5SW5kaWNlc1xuLy8gICAgY291bGQgY29udGFpbiBvYmplY3RzIHdpdGggZmxhZ3MgbGlrZSAnaW1wbGljaXQnLCBidXQgSSB0aGluayB0aGF0IG9ubHlcbi8vICAgIG1ha2VzIHRoZSBjb2RlIHN1cnJvdW5kaW5nIHRoZW0gbW9yZSBjb21wbGV4Lilcbi8vXG4vLyAgICAoQnkgdGhlIHdheSwgdGhpcyBmaWVsZCBlbmRzIHVwIGdldHRpbmcgcGFzc2VkIGFyb3VuZCBhIGxvdCB3aXRob3V0XG4vLyAgICBjbG9uaW5nLCBzbyBuZXZlciBtdXRhdGUgYW55IGFycmF5SW5kaWNlcyBmaWVsZC92YXIgaW4gdGhpcyBwYWNrYWdlISlcbi8vXG4vL1xuLy8gQXQgdGhlIHRvcCBsZXZlbCwgeW91IG1heSBvbmx5IHBhc3MgaW4gYSBwbGFpbiBvYmplY3Qgb3IgYXJyYXkuXG4vL1xuLy8gU2VlIHRoZSB0ZXN0ICdtaW5pbW9uZ28gLSBsb29rdXAnIGZvciBzb21lIGV4YW1wbGVzIG9mIHdoYXQgbG9va3VwIGZ1bmN0aW9uc1xuLy8gcmV0dXJuLlxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VMb29rdXBGdW5jdGlvbihrZXksIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCBwYXJ0cyA9IGtleS5zcGxpdCgnLicpO1xuICBjb25zdCBmaXJzdFBhcnQgPSBwYXJ0cy5sZW5ndGggPyBwYXJ0c1swXSA6ICcnO1xuICBjb25zdCBsb29rdXBSZXN0ID0gKFxuICAgIHBhcnRzLmxlbmd0aCA+IDEgJiZcbiAgICBtYWtlTG9va3VwRnVuY3Rpb24ocGFydHMuc2xpY2UoMSkuam9pbignLicpLCBvcHRpb25zKVxuICApO1xuXG4gIGZ1bmN0aW9uIGJ1aWxkUmVzdWx0KGFycmF5SW5kaWNlcywgZG9udEl0ZXJhdGUsIHZhbHVlKSB7XG4gICAgcmV0dXJuIGFycmF5SW5kaWNlcyAmJiBhcnJheUluZGljZXMubGVuZ3RoXG4gICAgICA/IGRvbnRJdGVyYXRlXG4gICAgICAgID8gW3sgYXJyYXlJbmRpY2VzLCBkb250SXRlcmF0ZSwgdmFsdWUgfV1cbiAgICAgICAgOiBbeyBhcnJheUluZGljZXMsIHZhbHVlIH1dXG4gICAgICA6IGRvbnRJdGVyYXRlXG4gICAgICAgID8gW3sgZG9udEl0ZXJhdGUsIHZhbHVlIH1dXG4gICAgICAgIDogW3sgdmFsdWUgfV07XG4gIH1cblxuICAvLyBEb2Mgd2lsbCBhbHdheXMgYmUgYSBwbGFpbiBvYmplY3Qgb3IgYW4gYXJyYXkuXG4gIC8vIGFwcGx5IGFuIGV4cGxpY2l0IG51bWVyaWMgaW5kZXgsIGFuIGFycmF5LlxuICByZXR1cm4gKGRvYywgYXJyYXlJbmRpY2VzKSA9PiB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgICAgLy8gSWYgd2UncmUgYmVpbmcgYXNrZWQgdG8gZG8gYW4gaW52YWxpZCBsb29rdXAgaW50byBhbiBhcnJheSAobm9uLWludGVnZXJcbiAgICAgIC8vIG9yIG91dC1vZi1ib3VuZHMpLCByZXR1cm4gbm8gcmVzdWx0cyAod2hpY2ggaXMgZGlmZmVyZW50IGZyb20gcmV0dXJuaW5nXG4gICAgICAvLyBhIHNpbmdsZSB1bmRlZmluZWQgcmVzdWx0LCBpbiB0aGF0IGBudWxsYCBlcXVhbGl0eSBjaGVja3Mgd29uJ3QgbWF0Y2gpLlxuICAgICAgaWYgKCEoaXNOdW1lcmljS2V5KGZpcnN0UGFydCkgJiYgZmlyc3RQYXJ0IDwgZG9jLmxlbmd0aCkpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfVxuXG4gICAgICAvLyBSZW1lbWJlciB0aGF0IHdlIHVzZWQgdGhpcyBhcnJheSBpbmRleC4gSW5jbHVkZSBhbiAneCcgdG8gaW5kaWNhdGUgdGhhdFxuICAgICAgLy8gdGhlIHByZXZpb3VzIGluZGV4IGNhbWUgZnJvbSBiZWluZyBjb25zaWRlcmVkIGFzIGFuIGV4cGxpY2l0IGFycmF5XG4gICAgICAvLyBpbmRleCAobm90IGJyYW5jaGluZykuXG4gICAgICBhcnJheUluZGljZXMgPSBhcnJheUluZGljZXMgPyBhcnJheUluZGljZXMuY29uY2F0KCtmaXJzdFBhcnQsICd4JykgOiBbK2ZpcnN0UGFydCwgJ3gnXTtcbiAgICB9XG5cbiAgICAvLyBEbyBvdXIgZmlyc3QgbG9va3VwLlxuICAgIGNvbnN0IGZpcnN0TGV2ZWwgPSBkb2NbZmlyc3RQYXJ0XTtcblxuICAgIC8vIElmIHRoZXJlIGlzIG5vIGRlZXBlciB0byBkaWcsIHJldHVybiB3aGF0IHdlIGZvdW5kLlxuICAgIC8vXG4gICAgLy8gSWYgd2hhdCB3ZSBmb3VuZCBpcyBhbiBhcnJheSwgbW9zdCB2YWx1ZSBzZWxlY3RvcnMgd2lsbCBjaG9vc2UgdG8gdHJlYXRcbiAgICAvLyB0aGUgZWxlbWVudHMgb2YgdGhlIGFycmF5IGFzIG1hdGNoYWJsZSB2YWx1ZXMgaW4gdGhlaXIgb3duIHJpZ2h0LCBidXRcbiAgICAvLyB0aGF0J3MgZG9uZSBvdXRzaWRlIG9mIHRoZSBsb29rdXAgZnVuY3Rpb24uIChFeGNlcHRpb25zIHRvIHRoaXMgYXJlICRzaXplXG4gICAgLy8gYW5kIHN0dWZmIHJlbGF0aW5nIHRvICRlbGVtTWF0Y2guICBlZywge2E6IHskc2l6ZTogMn19IGRvZXMgbm90IG1hdGNoIHthOlxuICAgIC8vIFtbMSwgMl1dfS4pXG4gICAgLy9cbiAgICAvLyBUaGF0IHNhaWQsIGlmIHdlIGp1c3QgZGlkIGFuICpleHBsaWNpdCogYXJyYXkgbG9va3VwIChvbiBkb2MpIHRvIGZpbmRcbiAgICAvLyBmaXJzdExldmVsLCBhbmQgZmlyc3RMZXZlbCBpcyBhbiBhcnJheSB0b28sIHdlIGRvIE5PVCB3YW50IHZhbHVlXG4gICAgLy8gc2VsZWN0b3JzIHRvIGl0ZXJhdGUgb3ZlciBpdC4gIGVnLCB7J2EuMCc6IDV9IGRvZXMgbm90IG1hdGNoIHthOiBbWzVdXX0uXG4gICAgLy8gU28gaW4gdGhhdCBjYXNlLCB3ZSBtYXJrIHRoZSByZXR1cm4gdmFsdWUgYXMgJ2Rvbid0IGl0ZXJhdGUnLlxuICAgIGlmICghbG9va3VwUmVzdCkge1xuICAgICAgcmV0dXJuIGJ1aWxkUmVzdWx0KFxuICAgICAgICBhcnJheUluZGljZXMsXG4gICAgICAgIEFycmF5LmlzQXJyYXkoZG9jKSAmJiBBcnJheS5pc0FycmF5KGZpcnN0TGV2ZWwpLFxuICAgICAgICBmaXJzdExldmVsLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBXZSBuZWVkIHRvIGRpZyBkZWVwZXIuICBCdXQgaWYgd2UgY2FuJ3QsIGJlY2F1c2Ugd2hhdCB3ZSd2ZSBmb3VuZCBpcyBub3RcbiAgICAvLyBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QsIHdlJ3JlIGRvbmUuIElmIHdlIGp1c3QgZGlkIGEgbnVtZXJpYyBpbmRleCBpbnRvXG4gICAgLy8gYW4gYXJyYXksIHdlIHJldHVybiBub3RoaW5nIGhlcmUgKHRoaXMgaXMgYSBjaGFuZ2UgaW4gTW9uZ28gMi41IGZyb21cbiAgICAvLyBNb25nbyAyLjQsIHdoZXJlIHsnYS4wLmInOiBudWxsfSBzdG9wcGVkIG1hdGNoaW5nIHthOiBbNV19KS4gT3RoZXJ3aXNlLFxuICAgIC8vIHJldHVybiBhIHNpbmdsZSBgdW5kZWZpbmVkYCAod2hpY2ggY2FuLCBmb3IgZXhhbXBsZSwgbWF0Y2ggdmlhIGVxdWFsaXR5XG4gICAgLy8gd2l0aCBgbnVsbGApLlxuICAgIGlmICghaXNJbmRleGFibGUoZmlyc3RMZXZlbCkpIHtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KGRvYykpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gYnVpbGRSZXN1bHQoYXJyYXlJbmRpY2VzLCBmYWxzZSwgdW5kZWZpbmVkKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBbXTtcbiAgICBjb25zdCBhcHBlbmRUb1Jlc3VsdCA9IG1vcmUgPT4ge1xuICAgICAgcmVzdWx0LnB1c2goLi4ubW9yZSk7XG4gICAgfTtcblxuICAgIC8vIERpZyBkZWVwZXI6IGxvb2sgdXAgdGhlIHJlc3Qgb2YgdGhlIHBhcnRzIG9uIHdoYXRldmVyIHdlJ3ZlIGZvdW5kLlxuICAgIC8vIChsb29rdXBSZXN0IGlzIHNtYXJ0IGVub3VnaCB0byBub3QgdHJ5IHRvIGRvIGludmFsaWQgbG9va3VwcyBpbnRvXG4gICAgLy8gZmlyc3RMZXZlbCBpZiBpdCdzIGFuIGFycmF5LilcbiAgICBhcHBlbmRUb1Jlc3VsdChsb29rdXBSZXN0KGZpcnN0TGV2ZWwsIGFycmF5SW5kaWNlcykpO1xuXG4gICAgLy8gSWYgd2UgZm91bmQgYW4gYXJyYXksIHRoZW4gaW4gKmFkZGl0aW9uKiB0byBwb3RlbnRpYWxseSB0cmVhdGluZyB0aGUgbmV4dFxuICAgIC8vIHBhcnQgYXMgYSBsaXRlcmFsIGludGVnZXIgbG9va3VwLCB3ZSBzaG91bGQgYWxzbyAnYnJhbmNoJzogdHJ5IHRvIGxvb2sgdXBcbiAgICAvLyB0aGUgcmVzdCBvZiB0aGUgcGFydHMgb24gZWFjaCBhcnJheSBlbGVtZW50IGluIHBhcmFsbGVsLlxuICAgIC8vXG4gICAgLy8gSW4gdGhpcyBjYXNlLCB3ZSAqb25seSogZGlnIGRlZXBlciBpbnRvIGFycmF5IGVsZW1lbnRzIHRoYXQgYXJlIHBsYWluXG4gICAgLy8gb2JqZWN0cy4gKFJlY2FsbCB0aGF0IHdlIG9ubHkgZ290IHRoaXMgZmFyIGlmIHdlIGhhdmUgZnVydGhlciB0byBkaWcuKVxuICAgIC8vIFRoaXMgbWFrZXMgc2Vuc2U6IHdlIGNlcnRhaW5seSBkb24ndCBkaWcgZGVlcGVyIGludG8gbm9uLWluZGV4YWJsZVxuICAgIC8vIG9iamVjdHMuIEFuZCBpdCB3b3VsZCBiZSB3ZWlyZCB0byBkaWcgaW50byBhbiBhcnJheTogaXQncyBzaW1wbGVyIHRvIGhhdmVcbiAgICAvLyBhIHJ1bGUgdGhhdCBleHBsaWNpdCBpbnRlZ2VyIGluZGV4ZXMgb25seSBhcHBseSB0byBhbiBvdXRlciBhcnJheSwgbm90IHRvXG4gICAgLy8gYW4gYXJyYXkgeW91IGZpbmQgYWZ0ZXIgYSBicmFuY2hpbmcgc2VhcmNoLlxuICAgIC8vXG4gICAgLy8gSW4gdGhlIHNwZWNpYWwgY2FzZSBvZiBhIG51bWVyaWMgcGFydCBpbiBhICpzb3J0IHNlbGVjdG9yKiAobm90IGEgcXVlcnlcbiAgICAvLyBzZWxlY3RvciksIHdlIHNraXAgdGhlIGJyYW5jaGluZzogd2UgT05MWSBhbGxvdyB0aGUgbnVtZXJpYyBwYXJ0IHRvIG1lYW5cbiAgICAvLyAnbG9vayB1cCB0aGlzIGluZGV4JyBpbiB0aGF0IGNhc2UsIG5vdCAnYWxzbyBsb29rIHVwIHRoaXMgaW5kZXggaW4gYWxsXG4gICAgLy8gdGhlIGVsZW1lbnRzIG9mIHRoZSBhcnJheScuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZmlyc3RMZXZlbCkgJiZcbiAgICAgICAgIShpc051bWVyaWNLZXkocGFydHNbMV0pICYmIG9wdGlvbnMuZm9yU29ydCkpIHtcbiAgICAgIGZpcnN0TGV2ZWwuZm9yRWFjaCgoYnJhbmNoLCBhcnJheUluZGV4KSA9PiB7XG4gICAgICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QoYnJhbmNoKSkge1xuICAgICAgICAgIGFwcGVuZFRvUmVzdWx0KGxvb2t1cFJlc3QoYnJhbmNoLCBhcnJheUluZGljZXMgPyBhcnJheUluZGljZXMuY29uY2F0KGFycmF5SW5kZXgpIDogW2FycmF5SW5kZXhdKSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG59XG5cbi8vIE9iamVjdCBleHBvcnRlZCBvbmx5IGZvciB1bml0IHRlc3RpbmcuXG4vLyBVc2UgaXQgdG8gZXhwb3J0IHByaXZhdGUgZnVuY3Rpb25zIHRvIHRlc3QgaW4gVGlueXRlc3QuXG5NaW5pbW9uZ29UZXN0ID0ge21ha2VMb29rdXBGdW5jdGlvbn07XG5NaW5pbW9uZ29FcnJvciA9IChtZXNzYWdlLCBvcHRpb25zID0ge30pID0+IHtcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJyAmJiBvcHRpb25zLmZpZWxkKSB7XG4gICAgbWVzc2FnZSArPSBgIGZvciBmaWVsZCAnJHtvcHRpb25zLmZpZWxkfSdgO1xuICB9XG5cbiAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG4gIGVycm9yLm5hbWUgPSAnTWluaW1vbmdvRXJyb3InO1xuICByZXR1cm4gZXJyb3I7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gbm90aGluZ01hdGNoZXIoZG9jT3JCcmFuY2hlZFZhbHVlcykge1xuICByZXR1cm4ge3Jlc3VsdDogZmFsc2V9O1xufVxuXG4vLyBUYWtlcyBhbiBvcGVyYXRvciBvYmplY3QgKGFuIG9iamVjdCB3aXRoICQga2V5cykgYW5kIHJldHVybnMgYSBicmFuY2hlZFxuLy8gbWF0Y2hlciBmb3IgaXQuXG5mdW5jdGlvbiBvcGVyYXRvckJyYW5jaGVkTWF0Y2hlcih2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyLCBpc1Jvb3QpIHtcbiAgLy8gRWFjaCB2YWx1ZVNlbGVjdG9yIHdvcmtzIHNlcGFyYXRlbHkgb24gdGhlIHZhcmlvdXMgYnJhbmNoZXMuICBTbyBvbmVcbiAgLy8gb3BlcmF0b3IgY2FuIG1hdGNoIG9uZSBicmFuY2ggYW5kIGFub3RoZXIgY2FuIG1hdGNoIGFub3RoZXIgYnJhbmNoLiAgVGhpc1xuICAvLyBpcyBPSy5cbiAgY29uc3Qgb3BlcmF0b3JNYXRjaGVycyA9IE9iamVjdC5rZXlzKHZhbHVlU2VsZWN0b3IpLm1hcChvcGVyYXRvciA9PiB7XG4gICAgY29uc3Qgb3BlcmFuZCA9IHZhbHVlU2VsZWN0b3Jbb3BlcmF0b3JdO1xuXG4gICAgY29uc3Qgc2ltcGxlUmFuZ2UgPSAoXG4gICAgICBbJyRsdCcsICckbHRlJywgJyRndCcsICckZ3RlJ10uaW5jbHVkZXMob3BlcmF0b3IpICYmXG4gICAgICB0eXBlb2Ygb3BlcmFuZCA9PT0gJ251bWJlcidcbiAgICApO1xuXG4gICAgY29uc3Qgc2ltcGxlRXF1YWxpdHkgPSAoXG4gICAgICBbJyRuZScsICckZXEnXS5pbmNsdWRlcyhvcGVyYXRvcikgJiZcbiAgICAgIG9wZXJhbmQgIT09IE9iamVjdChvcGVyYW5kKVxuICAgICk7XG5cbiAgICBjb25zdCBzaW1wbGVJbmNsdXNpb24gPSAoXG4gICAgICBbJyRpbicsICckbmluJ10uaW5jbHVkZXMob3BlcmF0b3IpXG4gICAgICAmJiBBcnJheS5pc0FycmF5KG9wZXJhbmQpXG4gICAgICAmJiAhb3BlcmFuZC5zb21lKHggPT4geCA9PT0gT2JqZWN0KHgpKVxuICAgICk7XG5cbiAgICBpZiAoIShzaW1wbGVSYW5nZSB8fCBzaW1wbGVJbmNsdXNpb24gfHwgc2ltcGxlRXF1YWxpdHkpKSB7XG4gICAgICBtYXRjaGVyLl9pc1NpbXBsZSA9IGZhbHNlO1xuICAgIH1cblxuICAgIGlmIChoYXNPd24uY2FsbChWQUxVRV9PUEVSQVRPUlMsIG9wZXJhdG9yKSkge1xuICAgICAgcmV0dXJuIFZBTFVFX09QRVJBVE9SU1tvcGVyYXRvcl0ob3BlcmFuZCwgdmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KTtcbiAgICB9XG5cbiAgICBpZiAoaGFzT3duLmNhbGwoRUxFTUVOVF9PUEVSQVRPUlMsIG9wZXJhdG9yKSkge1xuICAgICAgY29uc3Qgb3B0aW9ucyA9IEVMRU1FTlRfT1BFUkFUT1JTW29wZXJhdG9yXTtcbiAgICAgIHJldHVybiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihcbiAgICAgICAgb3B0aW9ucy5jb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIpLFxuICAgICAgICBvcHRpb25zXG4gICAgICApO1xuICAgIH1cblxuICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIG9wZXJhdG9yOiAke29wZXJhdG9yfWApO1xuICB9KTtcblxuICByZXR1cm4gYW5kQnJhbmNoZWRNYXRjaGVycyhvcGVyYXRvck1hdGNoZXJzKTtcbn1cblxuLy8gcGF0aHMgLSBBcnJheTogbGlzdCBvZiBtb25nbyBzdHlsZSBwYXRoc1xuLy8gbmV3TGVhZkZuIC0gRnVuY3Rpb246IG9mIGZvcm0gZnVuY3Rpb24ocGF0aCkgc2hvdWxkIHJldHVybiBhIHNjYWxhciB2YWx1ZSB0b1xuLy8gICAgICAgICAgICAgICAgICAgICAgIHB1dCBpbnRvIGxpc3QgY3JlYXRlZCBmb3IgdGhhdCBwYXRoXG4vLyBjb25mbGljdEZuIC0gRnVuY3Rpb246IG9mIGZvcm0gZnVuY3Rpb24obm9kZSwgcGF0aCwgZnVsbFBhdGgpIGlzIGNhbGxlZFxuLy8gICAgICAgICAgICAgICAgICAgICAgICB3aGVuIGJ1aWxkaW5nIGEgdHJlZSBwYXRoIGZvciAnZnVsbFBhdGgnIG5vZGUgb25cbi8vICAgICAgICAgICAgICAgICAgICAgICAgJ3BhdGgnIHdhcyBhbHJlYWR5IGEgbGVhZiB3aXRoIGEgdmFsdWUuIE11c3QgcmV0dXJuIGFcbi8vICAgICAgICAgICAgICAgICAgICAgICAgY29uZmxpY3QgcmVzb2x1dGlvbi5cbi8vIGluaXRpYWwgdHJlZSAtIE9wdGlvbmFsIE9iamVjdDogc3RhcnRpbmcgdHJlZS5cbi8vIEByZXR1cm5zIC0gT2JqZWN0OiB0cmVlIHJlcHJlc2VudGVkIGFzIGEgc2V0IG9mIG5lc3RlZCBvYmplY3RzXG5leHBvcnQgZnVuY3Rpb24gcGF0aHNUb1RyZWUocGF0aHMsIG5ld0xlYWZGbiwgY29uZmxpY3RGbiwgcm9vdCA9IHt9KSB7XG4gIHBhdGhzLmZvckVhY2gocGF0aCA9PiB7XG4gICAgY29uc3QgcGF0aEFycmF5ID0gcGF0aC5zcGxpdCgnLicpO1xuICAgIGxldCB0cmVlID0gcm9vdDtcblxuICAgIC8vIHVzZSAuZXZlcnkganVzdCBmb3IgaXRlcmF0aW9uIHdpdGggYnJlYWtcbiAgICBjb25zdCBzdWNjZXNzID0gcGF0aEFycmF5LnNsaWNlKDAsIC0xKS5ldmVyeSgoa2V5LCBpKSA9PiB7XG4gICAgICBpZiAoIWhhc093bi5jYWxsKHRyZWUsIGtleSkpIHtcbiAgICAgICAgdHJlZVtrZXldID0ge307XG4gICAgICB9IGVsc2UgaWYgKHRyZWVba2V5XSAhPT0gT2JqZWN0KHRyZWVba2V5XSkpIHtcbiAgICAgICAgdHJlZVtrZXldID0gY29uZmxpY3RGbihcbiAgICAgICAgICB0cmVlW2tleV0sXG4gICAgICAgICAgcGF0aEFycmF5LnNsaWNlKDAsIGkgKyAxKS5qb2luKCcuJyksXG4gICAgICAgICAgcGF0aFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIGJyZWFrIG91dCBvZiBsb29wIGlmIHdlIGFyZSBmYWlsaW5nIGZvciB0aGlzIHBhdGhcbiAgICAgICAgaWYgKHRyZWVba2V5XSAhPT0gT2JqZWN0KHRyZWVba2V5XSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdHJlZSA9IHRyZWVba2V5XTtcblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG5cbiAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgY29uc3QgbGFzdEtleSA9IHBhdGhBcnJheVtwYXRoQXJyYXkubGVuZ3RoIC0gMV07XG4gICAgICBpZiAoaGFzT3duLmNhbGwodHJlZSwgbGFzdEtleSkpIHtcbiAgICAgICAgdHJlZVtsYXN0S2V5XSA9IGNvbmZsaWN0Rm4odHJlZVtsYXN0S2V5XSwgcGF0aCwgcGF0aCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cmVlW2xhc3RLZXldID0gbmV3TGVhZkZuKHBhdGgpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHJvb3Q7XG59XG5cbi8vIE1ha2VzIHN1cmUgd2UgZ2V0IDIgZWxlbWVudHMgYXJyYXkgYW5kIGFzc3VtZSB0aGUgZmlyc3Qgb25lIHRvIGJlIHggYW5kXG4vLyB0aGUgc2Vjb25kIG9uZSB0byB5IG5vIG1hdHRlciB3aGF0IHVzZXIgcGFzc2VzLlxuLy8gSW4gY2FzZSB1c2VyIHBhc3NlcyB7IGxvbjogeCwgbGF0OiB5IH0gcmV0dXJucyBbeCwgeV1cbmZ1bmN0aW9uIHBvaW50VG9BcnJheShwb2ludCkge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShwb2ludCkgPyBwb2ludC5zbGljZSgpIDogW3BvaW50LngsIHBvaW50LnldO1xufVxuXG4vLyBDcmVhdGluZyBhIGRvY3VtZW50IGZyb20gYW4gdXBzZXJ0IGlzIHF1aXRlIHRyaWNreS5cbi8vIEUuZy4gdGhpcyBzZWxlY3Rvcjoge1wiJG9yXCI6IFt7XCJiLmZvb1wiOiB7XCIkYWxsXCI6IFtcImJhclwiXX19XX0sIHNob3VsZCByZXN1bHRcbi8vIGluOiB7XCJiLmZvb1wiOiBcImJhclwifVxuLy8gQnV0IHRoaXMgc2VsZWN0b3I6IHtcIiRvclwiOiBbe1wiYlwiOiB7XCJmb29cIjoge1wiJGFsbFwiOiBbXCJiYXJcIl19fX1dfSBzaG91bGQgdGhyb3dcbi8vIGFuIGVycm9yXG5cbi8vIFNvbWUgcnVsZXMgKGZvdW5kIG1haW5seSB3aXRoIHRyaWFsICYgZXJyb3IsIHNvIHRoZXJlIG1pZ2h0IGJlIG1vcmUpOlxuLy8gLSBoYW5kbGUgYWxsIGNoaWxkcyBvZiAkYW5kIChvciBpbXBsaWNpdCAkYW5kKVxuLy8gLSBoYW5kbGUgJG9yIG5vZGVzIHdpdGggZXhhY3RseSAxIGNoaWxkXG4vLyAtIGlnbm9yZSAkb3Igbm9kZXMgd2l0aCBtb3JlIHRoYW4gMSBjaGlsZFxuLy8gLSBpZ25vcmUgJG5vciBhbmQgJG5vdCBub2Rlc1xuLy8gLSB0aHJvdyB3aGVuIGEgdmFsdWUgY2FuIG5vdCBiZSBzZXQgdW5hbWJpZ3VvdXNseVxuLy8gLSBldmVyeSB2YWx1ZSBmb3IgJGFsbCBzaG91bGQgYmUgZGVhbHQgd2l0aCBhcyBzZXBhcmF0ZSAkZXEtc1xuLy8gLSB0aHJlYXQgYWxsIGNoaWxkcmVuIG9mICRhbGwgYXMgJGVxIHNldHRlcnMgKD0+IHNldCBpZiAkYWxsLmxlbmd0aCA9PT0gMSxcbi8vICAgb3RoZXJ3aXNlIHRocm93IGVycm9yKVxuLy8gLSB5b3UgY2FuIG5vdCBtaXggJyQnLXByZWZpeGVkIGtleXMgYW5kIG5vbi0nJCctcHJlZml4ZWQga2V5c1xuLy8gLSB5b3UgY2FuIG9ubHkgaGF2ZSBkb3R0ZWQga2V5cyBvbiBhIHJvb3QtbGV2ZWxcbi8vIC0geW91IGNhbiBub3QgaGF2ZSAnJCctcHJlZml4ZWQga2V5cyBtb3JlIHRoYW4gb25lLWxldmVsIGRlZXAgaW4gYW4gb2JqZWN0XG5cbi8vIEhhbmRsZXMgb25lIGtleS92YWx1ZSBwYWlyIHRvIHB1dCBpbiB0aGUgc2VsZWN0b3IgZG9jdW1lbnRcbmZ1bmN0aW9uIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgaWYgKHZhbHVlICYmIE9iamVjdC5nZXRQcm90b3R5cGVPZih2YWx1ZSkgPT09IE9iamVjdC5wcm90b3R5cGUpIHtcbiAgICBwb3B1bGF0ZURvY3VtZW50V2l0aE9iamVjdChkb2N1bWVudCwga2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSBpZiAoISh2YWx1ZSBpbnN0YW5jZW9mIFJlZ0V4cCkpIHtcbiAgICBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICB9XG59XG5cbi8vIEhhbmRsZXMgYSBrZXksIHZhbHVlIHBhaXIgdG8gcHV0IGluIHRoZSBzZWxlY3RvciBkb2N1bWVudFxuLy8gaWYgdGhlIHZhbHVlIGlzIGFuIG9iamVjdFxuZnVuY3Rpb24gcG9wdWxhdGVEb2N1bWVudFdpdGhPYmplY3QoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgY29uc3QgdW5wcmVmaXhlZEtleXMgPSBrZXlzLmZpbHRlcihvcCA9PiBvcFswXSAhPT0gJyQnKTtcblxuICBpZiAodW5wcmVmaXhlZEtleXMubGVuZ3RoID4gMCB8fCAha2V5cy5sZW5ndGgpIHtcbiAgICAvLyBMaXRlcmFsIChwb3NzaWJseSBlbXB0eSkgb2JqZWN0ICggb3IgZW1wdHkgb2JqZWN0IClcbiAgICAvLyBEb24ndCBhbGxvdyBtaXhpbmcgJyQnLXByZWZpeGVkIHdpdGggbm9uLSckJy1wcmVmaXhlZCBmaWVsZHNcbiAgICBpZiAoa2V5cy5sZW5ndGggIT09IHVucHJlZml4ZWRLZXlzLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIG9wZXJhdG9yOiAke3VucHJlZml4ZWRLZXlzWzBdfWApO1xuICAgIH1cblxuICAgIHZhbGlkYXRlT2JqZWN0KHZhbHVlLCBrZXkpO1xuICAgIGluc2VydEludG9Eb2N1bWVudChkb2N1bWVudCwga2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgT2JqZWN0LmtleXModmFsdWUpLmZvckVhY2gob3AgPT4ge1xuICAgICAgY29uc3Qgb2JqZWN0ID0gdmFsdWVbb3BdO1xuXG4gICAgICBpZiAob3AgPT09ICckZXEnKSB7XG4gICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgb2JqZWN0KTtcbiAgICAgIH0gZWxzZSBpZiAob3AgPT09ICckYWxsJykge1xuICAgICAgICAvLyBldmVyeSB2YWx1ZSBmb3IgJGFsbCBzaG91bGQgYmUgZGVhbHQgd2l0aCBhcyBzZXBhcmF0ZSAkZXEtc1xuICAgICAgICBvYmplY3QuZm9yRWFjaChlbGVtZW50ID0+XG4gICAgICAgICAgcG9wdWxhdGVEb2N1bWVudFdpdGhLZXlWYWx1ZShkb2N1bWVudCwga2V5LCBlbGVtZW50KVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG59XG5cbi8vIEZpbGxzIGEgZG9jdW1lbnQgd2l0aCBjZXJ0YWluIGZpZWxkcyBmcm9tIGFuIHVwc2VydCBzZWxlY3RvclxuZXhwb3J0IGZ1bmN0aW9uIHBvcHVsYXRlRG9jdW1lbnRXaXRoUXVlcnlGaWVsZHMocXVlcnksIGRvY3VtZW50ID0ge30pIHtcbiAgaWYgKE9iamVjdC5nZXRQcm90b3R5cGVPZihxdWVyeSkgPT09IE9iamVjdC5wcm90b3R5cGUpIHtcbiAgICAvLyBoYW5kbGUgaW1wbGljaXQgJGFuZFxuICAgIE9iamVjdC5rZXlzKHF1ZXJ5KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHF1ZXJ5W2tleV07XG5cbiAgICAgIGlmIChrZXkgPT09ICckYW5kJykge1xuICAgICAgICAvLyBoYW5kbGUgZXhwbGljaXQgJGFuZFxuICAgICAgICB2YWx1ZS5mb3JFYWNoKGVsZW1lbnQgPT5cbiAgICAgICAgICBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzKGVsZW1lbnQsIGRvY3VtZW50KVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChrZXkgPT09ICckb3InKSB7XG4gICAgICAgIC8vIGhhbmRsZSAkb3Igbm9kZXMgd2l0aCBleGFjdGx5IDEgY2hpbGRcbiAgICAgICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoUXVlcnlGaWVsZHModmFsdWVbMF0sIGRvY3VtZW50KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChrZXlbMF0gIT09ICckJykge1xuICAgICAgICAvLyBJZ25vcmUgb3RoZXIgJyQnLXByZWZpeGVkIGxvZ2ljYWwgc2VsZWN0b3JzXG4gICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICAgICAgfVxuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIEhhbmRsZSBtZXRlb3Itc3BlY2lmaWMgc2hvcnRjdXQgZm9yIHNlbGVjdGluZyBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQocXVlcnkpKSB7XG4gICAgICBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsICdfaWQnLCBxdWVyeSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGRvY3VtZW50O1xufVxuXG4vLyBUcmF2ZXJzZXMgdGhlIGtleXMgb2YgcGFzc2VkIHByb2plY3Rpb24gYW5kIGNvbnN0cnVjdHMgYSB0cmVlIHdoZXJlIGFsbFxuLy8gbGVhdmVzIGFyZSBlaXRoZXIgYWxsIFRydWUgb3IgYWxsIEZhbHNlXG4vLyBAcmV0dXJucyBPYmplY3Q6XG4vLyAgLSB0cmVlIC0gT2JqZWN0IC0gdHJlZSByZXByZXNlbnRhdGlvbiBvZiBrZXlzIGludm9sdmVkIGluIHByb2plY3Rpb25cbi8vICAoZXhjZXB0aW9uIGZvciAnX2lkJyBhcyBpdCBpcyBhIHNwZWNpYWwgY2FzZSBoYW5kbGVkIHNlcGFyYXRlbHkpXG4vLyAgLSBpbmNsdWRpbmcgLSBCb29sZWFuIC0gXCJ0YWtlIG9ubHkgY2VydGFpbiBmaWVsZHNcIiB0eXBlIG9mIHByb2plY3Rpb25cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0aW9uRGV0YWlscyhmaWVsZHMpIHtcbiAgLy8gRmluZCB0aGUgbm9uLV9pZCBrZXlzIChfaWQgaXMgaGFuZGxlZCBzcGVjaWFsbHkgYmVjYXVzZSBpdCBpcyBpbmNsdWRlZFxuICAvLyB1bmxlc3MgZXhwbGljaXRseSBleGNsdWRlZCkuIFNvcnQgdGhlIGtleXMsIHNvIHRoYXQgb3VyIGNvZGUgdG8gZGV0ZWN0XG4gIC8vIG92ZXJsYXBzIGxpa2UgJ2ZvbycgYW5kICdmb28uYmFyJyBjYW4gYXNzdW1lIHRoYXQgJ2ZvbycgY29tZXMgZmlyc3QuXG4gIGxldCBmaWVsZHNLZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKS5zb3J0KCk7XG5cbiAgLy8gSWYgX2lkIGlzIHRoZSBvbmx5IGZpZWxkIGluIHRoZSBwcm9qZWN0aW9uLCBkbyBub3QgcmVtb3ZlIGl0LCBzaW5jZSBpdCBpc1xuICAvLyByZXF1aXJlZCB0byBkZXRlcm1pbmUgaWYgdGhpcyBpcyBhbiBleGNsdXNpb24gb3IgZXhjbHVzaW9uLiBBbHNvIGtlZXAgYW5cbiAgLy8gaW5jbHVzaXZlIF9pZCwgc2luY2UgaW5jbHVzaXZlIF9pZCBmb2xsb3dzIHRoZSBub3JtYWwgcnVsZXMgYWJvdXQgbWl4aW5nXG4gIC8vIGluY2x1c2l2ZSBhbmQgZXhjbHVzaXZlIGZpZWxkcy4gSWYgX2lkIGlzIG5vdCB0aGUgb25seSBmaWVsZCBpbiB0aGVcbiAgLy8gcHJvamVjdGlvbiBhbmQgaXMgZXhjbHVzaXZlLCByZW1vdmUgaXQgc28gaXQgY2FuIGJlIGhhbmRsZWQgbGF0ZXIgYnkgYVxuICAvLyBzcGVjaWFsIGNhc2UsIHNpbmNlIGV4Y2x1c2l2ZSBfaWQgaXMgYWx3YXlzIGFsbG93ZWQuXG4gIGlmICghKGZpZWxkc0tleXMubGVuZ3RoID09PSAxICYmIGZpZWxkc0tleXNbMF0gPT09ICdfaWQnKSAmJlxuICAgICAgIShmaWVsZHNLZXlzLmluY2x1ZGVzKCdfaWQnKSAmJiBmaWVsZHMuX2lkKSkge1xuICAgIGZpZWxkc0tleXMgPSBmaWVsZHNLZXlzLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnX2lkJyk7XG4gIH1cblxuICBsZXQgaW5jbHVkaW5nID0gbnVsbDsgLy8gVW5rbm93blxuXG4gIGZpZWxkc0tleXMuZm9yRWFjaChrZXlQYXRoID0+IHtcbiAgICBjb25zdCBydWxlID0gISFmaWVsZHNba2V5UGF0aF07XG5cbiAgICBpZiAoaW5jbHVkaW5nID09PSBudWxsKSB7XG4gICAgICBpbmNsdWRpbmcgPSBydWxlO1xuICAgIH1cblxuICAgIC8vIFRoaXMgZXJyb3IgbWVzc2FnZSBpcyBjb3BpZWQgZnJvbSBNb25nb0RCIHNoZWxsXG4gICAgaWYgKGluY2x1ZGluZyAhPT0gcnVsZSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdZb3UgY2Fubm90IGN1cnJlbnRseSBtaXggaW5jbHVkaW5nIGFuZCBleGNsdWRpbmcgZmllbGRzLidcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBjb25zdCBwcm9qZWN0aW9uUnVsZXNUcmVlID0gcGF0aHNUb1RyZWUoXG4gICAgZmllbGRzS2V5cyxcbiAgICBwYXRoID0+IGluY2x1ZGluZyxcbiAgICAobm9kZSwgcGF0aCwgZnVsbFBhdGgpID0+IHtcbiAgICAgIC8vIENoZWNrIHBhc3NlZCBwcm9qZWN0aW9uIGZpZWxkcycga2V5czogSWYgeW91IGhhdmUgdHdvIHJ1bGVzIHN1Y2ggYXNcbiAgICAgIC8vICdmb28uYmFyJyBhbmQgJ2Zvby5iYXIuYmF6JywgdGhlbiB0aGUgcmVzdWx0IGJlY29tZXMgYW1iaWd1b3VzLiBJZlxuICAgICAgLy8gdGhhdCBoYXBwZW5zLCB0aGVyZSBpcyBhIHByb2JhYmlsaXR5IHlvdSBhcmUgZG9pbmcgc29tZXRoaW5nIHdyb25nLFxuICAgICAgLy8gZnJhbWV3b3JrIHNob3VsZCBub3RpZnkgeW91IGFib3V0IHN1Y2ggbWlzdGFrZSBlYXJsaWVyIG9uIGN1cnNvclxuICAgICAgLy8gY29tcGlsYXRpb24gc3RlcCB0aGFuIGxhdGVyIGR1cmluZyBydW50aW1lLiAgTm90ZSwgdGhhdCByZWFsIG1vbmdvXG4gICAgICAvLyBkb2Vzbid0IGRvIGFueXRoaW5nIGFib3V0IGl0IGFuZCB0aGUgbGF0ZXIgcnVsZSBhcHBlYXJzIGluIHByb2plY3Rpb25cbiAgICAgIC8vIHByb2plY3QsIG1vcmUgcHJpb3JpdHkgaXQgdGFrZXMuXG4gICAgICAvL1xuICAgICAgLy8gRXhhbXBsZSwgYXNzdW1lIGZvbGxvd2luZyBpbiBtb25nbyBzaGVsbDpcbiAgICAgIC8vID4gZGIuY29sbC5pbnNlcnQoeyBhOiB7IGI6IDIzLCBjOiA0NCB9IH0pXG4gICAgICAvLyA+IGRiLmNvbGwuZmluZCh7fSwgeyAnYSc6IDEsICdhLmInOiAxIH0pXG4gICAgICAvLyB7XCJfaWRcIjogT2JqZWN0SWQoXCI1MjBiZmU0NTYwMjQ2MDhlOGVmMjRhZjNcIiksIFwiYVwiOiB7XCJiXCI6IDIzfX1cbiAgICAgIC8vID4gZGIuY29sbC5maW5kKHt9LCB7ICdhLmInOiAxLCAnYSc6IDEgfSlcbiAgICAgIC8vIHtcIl9pZFwiOiBPYmplY3RJZChcIjUyMGJmZTQ1NjAyNDYwOGU4ZWYyNGFmM1wiKSwgXCJhXCI6IHtcImJcIjogMjMsIFwiY1wiOiA0NH19XG4gICAgICAvL1xuICAgICAgLy8gTm90ZSwgaG93IHNlY29uZCB0aW1lIHRoZSByZXR1cm4gc2V0IG9mIGtleXMgaXMgZGlmZmVyZW50LlxuICAgICAgY29uc3QgY3VycmVudFBhdGggPSBmdWxsUGF0aDtcbiAgICAgIGNvbnN0IGFub3RoZXJQYXRoID0gcGF0aDtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgYm90aCAke2N1cnJlbnRQYXRofSBhbmQgJHthbm90aGVyUGF0aH0gZm91bmQgaW4gZmllbGRzIG9wdGlvbiwgYCArXG4gICAgICAgICd1c2luZyBib3RoIG9mIHRoZW0gbWF5IHRyaWdnZXIgdW5leHBlY3RlZCBiZWhhdmlvci4gRGlkIHlvdSBtZWFuIHRvICcgK1xuICAgICAgICAndXNlIG9ubHkgb25lIG9mIHRoZW0/J1xuICAgICAgKTtcbiAgICB9KTtcblxuICByZXR1cm4ge2luY2x1ZGluZywgdHJlZTogcHJvamVjdGlvblJ1bGVzVHJlZX07XG59XG5cbi8vIFRha2VzIGEgUmVnRXhwIG9iamVjdCBhbmQgcmV0dXJucyBhbiBlbGVtZW50IG1hdGNoZXIuXG5leHBvcnQgZnVuY3Rpb24gcmVnZXhwRWxlbWVudE1hdGNoZXIocmVnZXhwKSB7XG4gIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICByZXR1cm4gdmFsdWUudG9TdHJpbmcoKSA9PT0gcmVnZXhwLnRvU3RyaW5nKCk7XG4gICAgfVxuXG4gICAgLy8gUmVnZXhwcyBvbmx5IHdvcmsgYWdhaW5zdCBzdHJpbmdzLlxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUmVzZXQgcmVnZXhwJ3Mgc3RhdGUgdG8gYXZvaWQgaW5jb25zaXN0ZW50IG1hdGNoaW5nIGZvciBvYmplY3RzIHdpdGggdGhlXG4gICAgLy8gc2FtZSB2YWx1ZSBvbiBjb25zZWN1dGl2ZSBjYWxscyBvZiByZWdleHAudGVzdC4gVGhpcyBoYXBwZW5zIG9ubHkgaWYgdGhlXG4gICAgLy8gcmVnZXhwIGhhcyB0aGUgJ2cnIGZsYWcuIEFsc28gbm90ZSB0aGF0IEVTNiBpbnRyb2R1Y2VzIGEgbmV3IGZsYWcgJ3knIGZvclxuICAgIC8vIHdoaWNoIHdlIHNob3VsZCAqbm90KiBjaGFuZ2UgdGhlIGxhc3RJbmRleCBidXQgTW9uZ29EQiBkb2Vzbid0IHN1cHBvcnRcbiAgICAvLyBlaXRoZXIgb2YgdGhlc2UgZmxhZ3MuXG4gICAgcmVnZXhwLmxhc3RJbmRleCA9IDA7XG5cbiAgICByZXR1cm4gcmVnZXhwLnRlc3QodmFsdWUpO1xuICB9O1xufVxuXG4vLyBWYWxpZGF0ZXMgdGhlIGtleSBpbiBhIHBhdGguXG4vLyBPYmplY3RzIHRoYXQgYXJlIG5lc3RlZCBtb3JlIHRoZW4gMSBsZXZlbCBjYW5ub3QgaGF2ZSBkb3R0ZWQgZmllbGRzXG4vLyBvciBmaWVsZHMgc3RhcnRpbmcgd2l0aCAnJCdcbmZ1bmN0aW9uIHZhbGlkYXRlS2V5SW5QYXRoKGtleSwgcGF0aCkge1xuICBpZiAoa2V5LmluY2x1ZGVzKCcuJykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVGhlIGRvdHRlZCBmaWVsZCAnJHtrZXl9JyBpbiAnJHtwYXRofS4ke2tleX0gaXMgbm90IHZhbGlkIGZvciBzdG9yYWdlLmBcbiAgICApO1xuICB9XG5cbiAgaWYgKGtleVswXSA9PT0gJyQnKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBkb2xsYXIgKCQpIHByZWZpeGVkIGZpZWxkICAnJHtwYXRofS4ke2tleX0gaXMgbm90IHZhbGlkIGZvciBzdG9yYWdlLmBcbiAgICApO1xuICB9XG59XG5cbi8vIFJlY3Vyc2l2ZWx5IHZhbGlkYXRlcyBhbiBvYmplY3QgdGhhdCBpcyBuZXN0ZWQgbW9yZSB0aGFuIG9uZSBsZXZlbCBkZWVwXG5mdW5jdGlvbiB2YWxpZGF0ZU9iamVjdChvYmplY3QsIHBhdGgpIHtcbiAgaWYgKG9iamVjdCAmJiBPYmplY3QuZ2V0UHJvdG90eXBlT2Yob2JqZWN0KSA9PT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgdmFsaWRhdGVLZXlJblBhdGgoa2V5LCBwYXRoKTtcbiAgICAgIHZhbGlkYXRlT2JqZWN0KG9iamVjdFtrZXldLCBwYXRoICsgJy4nICsga2V5KTtcbiAgICB9KTtcbiAgfVxufVxuIiwiLyoqIEV4cG9ydGVkIHZhbHVlcyBhcmUgYWxzbyB1c2VkIGluIHRoZSBtb25nbyBwYWNrYWdlLiAqL1xuXG4vKiogQHBhcmFtIHtzdHJpbmd9IG1ldGhvZCAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFzeW5jTWV0aG9kTmFtZShtZXRob2QpIHtcbiAgcmV0dXJuIGAke21ldGhvZC5yZXBsYWNlKCdfJywgJycpfUFzeW5jYDtcbn1cblxuZXhwb3J0IGNvbnN0IEFTWU5DX0NPTExFQ1RJT05fTUVUSE9EUyA9IFtcbiAgJ19jcmVhdGVDYXBwZWRDb2xsZWN0aW9uJyxcbiAgJ19kcm9wQ29sbGVjdGlvbicsXG4gICdfZHJvcEluZGV4JyxcbiAgJ2NyZWF0ZUluZGV4JyxcbiAgJ2ZpbmRPbmUnLFxuICAnaW5zZXJ0JyxcbiAgJ3JlbW92ZScsXG4gICd1cGRhdGUnLFxuICAndXBzZXJ0Jyxcbl07XG5cbmV4cG9ydCBjb25zdCBBU1lOQ19DVVJTT1JfTUVUSE9EUyA9IFsnY291bnQnLCAnZmV0Y2gnLCAnZm9yRWFjaCcsICdtYXAnXTtcbiIsImltcG9ydCBMb2NhbENvbGxlY3Rpb24gZnJvbSAnLi9sb2NhbF9jb2xsZWN0aW9uLmpzJztcbmltcG9ydCB7IGhhc093biB9IGZyb20gJy4vY29tbW9uLmpzJztcbmltcG9ydCB7IEFTWU5DX0NVUlNPUl9NRVRIT0RTLCBnZXRBc3luY01ldGhvZE5hbWUgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcblxuLy8gQ3Vyc29yOiBhIHNwZWNpZmljYXRpb24gZm9yIGEgcGFydGljdWxhciBzdWJzZXQgb2YgZG9jdW1lbnRzLCB3LyBhIGRlZmluZWRcbi8vIG9yZGVyLCBsaW1pdCwgYW5kIG9mZnNldC4gIGNyZWF0aW5nIGEgQ3Vyc29yIHdpdGggTG9jYWxDb2xsZWN0aW9uLmZpbmQoKSxcbmV4cG9ydCBkZWZhdWx0IGNsYXNzIEN1cnNvciB7XG4gIC8vIGRvbid0IGNhbGwgdGhpcyBjdG9yIGRpcmVjdGx5LiAgdXNlIExvY2FsQ29sbGVjdGlvbi5maW5kKCkuXG4gIGNvbnN0cnVjdG9yKGNvbGxlY3Rpb24sIHNlbGVjdG9yLCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLmNvbGxlY3Rpb24gPSBjb2xsZWN0aW9uO1xuICAgIHRoaXMuc29ydGVyID0gbnVsbDtcbiAgICB0aGlzLm1hdGNoZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoc2VsZWN0b3IpO1xuXG4gICAgaWYgKExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkUGVyaGFwc0FzT2JqZWN0KHNlbGVjdG9yKSkge1xuICAgICAgLy8gc3Rhc2ggZm9yIGZhc3QgX2lkIGFuZCB7IF9pZCB9XG4gICAgICB0aGlzLl9zZWxlY3RvcklkID0gaGFzT3duLmNhbGwoc2VsZWN0b3IsICdfaWQnKVxuICAgICAgICA/IHNlbGVjdG9yLl9pZFxuICAgICAgICA6IHNlbGVjdG9yO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9zZWxlY3RvcklkID0gdW5kZWZpbmVkO1xuXG4gICAgICBpZiAodGhpcy5tYXRjaGVyLmhhc0dlb1F1ZXJ5KCkgfHwgb3B0aW9ucy5zb3J0KSB7XG4gICAgICAgIHRoaXMuc29ydGVyID0gbmV3IE1pbmltb25nby5Tb3J0ZXIob3B0aW9ucy5zb3J0IHx8IFtdKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLnNraXAgPSBvcHRpb25zLnNraXAgfHwgMDtcbiAgICB0aGlzLmxpbWl0ID0gb3B0aW9ucy5saW1pdDtcbiAgICB0aGlzLmZpZWxkcyA9IG9wdGlvbnMucHJvamVjdGlvbiB8fCBvcHRpb25zLmZpZWxkcztcblxuICAgIHRoaXMuX3Byb2plY3Rpb25GbiA9IExvY2FsQ29sbGVjdGlvbi5fY29tcGlsZVByb2plY3Rpb24odGhpcy5maWVsZHMgfHwge30pO1xuXG4gICAgdGhpcy5fdHJhbnNmb3JtID0gTG9jYWxDb2xsZWN0aW9uLndyYXBUcmFuc2Zvcm0ob3B0aW9ucy50cmFuc2Zvcm0pO1xuXG4gICAgLy8gYnkgZGVmYXVsdCwgcXVlcmllcyByZWdpc3RlciB3LyBUcmFja2VyIHdoZW4gaXQgaXMgYXZhaWxhYmxlLlxuICAgIGlmICh0eXBlb2YgVHJhY2tlciAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRoaXMucmVhY3RpdmUgPSBvcHRpb25zLnJlYWN0aXZlID09PSB1bmRlZmluZWQgPyB0cnVlIDogb3B0aW9ucy5yZWFjdGl2ZTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQGRlcHJlY2F0ZWQgaW4gMi45XG4gICAqIEBzdW1tYXJ5IFJldHVybnMgdGhlIG51bWJlciBvZiBkb2N1bWVudHMgdGhhdCBtYXRjaCBhIHF1ZXJ5LiBUaGlzIG1ldGhvZCBpc1xuICAgKiAgICAgICAgICBbZGVwcmVjYXRlZCBzaW5jZSBNb25nb0RCIDQuMF0oaHR0cHM6Ly93d3cubW9uZ29kYi5jb20vZG9jcy92NC40L3JlZmVyZW5jZS9jb21tYW5kL2NvdW50Lyk7XG4gICAqICAgICAgICAgIHNlZSBgQ29sbGVjdGlvbi5jb3VudERvY3VtZW50c2AgYW5kXG4gICAqICAgICAgICAgIGBDb2xsZWN0aW9uLmVzdGltYXRlZERvY3VtZW50Q291bnRgIGZvciBhIHJlcGxhY2VtZW50LlxuICAgKiBAbWVtYmVyT2YgTW9uZ28uQ3Vyc29yXG4gICAqIEBtZXRob2QgIGNvdW50XG4gICAqIEBpbnN0YW5jZVxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQHJldHVybnMge051bWJlcn1cbiAgICovXG4gIGNvdW50KCkge1xuICAgIGlmICh0aGlzLnJlYWN0aXZlKSB7XG4gICAgICAvLyBhbGxvdyB0aGUgb2JzZXJ2ZSB0byBiZSB1bm9yZGVyZWRcbiAgICAgIHRoaXMuX2RlcGVuZCh7YWRkZWQ6IHRydWUsIHJlbW92ZWQ6IHRydWV9LCB0cnVlKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fZ2V0UmF3T2JqZWN0cyh7XG4gICAgICBvcmRlcmVkOiB0cnVlLFxuICAgIH0pLmxlbmd0aDtcbiAgfVxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBSZXR1cm4gYWxsIG1hdGNoaW5nIGRvY3VtZW50cyBhcyBhbiBBcnJheS5cbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAbWV0aG9kICBmZXRjaFxuICAgKiBAaW5zdGFuY2VcbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEByZXR1cm5zIHtPYmplY3RbXX1cbiAgICovXG4gIGZldGNoKCkge1xuICAgIGNvbnN0IHJlc3VsdCA9IFtdO1xuXG4gICAgdGhpcy5mb3JFYWNoKGRvYyA9PiB7XG4gICAgICByZXN1bHQucHVzaChkb2MpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIFtTeW1ib2wuaXRlcmF0b3JdKCkge1xuICAgIGlmICh0aGlzLnJlYWN0aXZlKSB7XG4gICAgICB0aGlzLl9kZXBlbmQoe1xuICAgICAgICBhZGRlZEJlZm9yZTogdHJ1ZSxcbiAgICAgICAgcmVtb3ZlZDogdHJ1ZSxcbiAgICAgICAgY2hhbmdlZDogdHJ1ZSxcbiAgICAgICAgbW92ZWRCZWZvcmU6IHRydWV9KTtcbiAgICB9XG5cbiAgICBsZXQgaW5kZXggPSAwO1xuICAgIGNvbnN0IG9iamVjdHMgPSB0aGlzLl9nZXRSYXdPYmplY3RzKHtvcmRlcmVkOiB0cnVlfSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgbmV4dDogKCkgPT4ge1xuICAgICAgICBpZiAoaW5kZXggPCBvYmplY3RzLmxlbmd0aCkge1xuICAgICAgICAgIC8vIFRoaXMgZG91YmxlcyBhcyBhIGNsb25lIG9wZXJhdGlvbi5cbiAgICAgICAgICBsZXQgZWxlbWVudCA9IHRoaXMuX3Byb2plY3Rpb25GbihvYmplY3RzW2luZGV4KytdKTtcblxuICAgICAgICAgIGlmICh0aGlzLl90cmFuc2Zvcm0pXG4gICAgICAgICAgICBlbGVtZW50ID0gdGhpcy5fdHJhbnNmb3JtKGVsZW1lbnQpO1xuXG4gICAgICAgICAgcmV0dXJuIHt2YWx1ZTogZWxlbWVudH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge2RvbmU6IHRydWV9O1xuICAgICAgfVxuICAgIH07XG4gIH1cblxuICBbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCkge1xuICAgIGNvbnN0IHN5bmNSZXN1bHQgPSB0aGlzW1N5bWJvbC5pdGVyYXRvcl0oKTtcbiAgICByZXR1cm4ge1xuICAgICAgYXN5bmMgbmV4dCgpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShzeW5jUmVzdWx0Lm5leHQoKSk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAY2FsbGJhY2sgSXRlcmF0aW9uQ2FsbGJhY2tcbiAgICogQHBhcmFtIHtPYmplY3R9IGRvY1xuICAgKiBAcGFyYW0ge051bWJlcn0gaW5kZXhcbiAgICovXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGBjYWxsYmFja2Agb25jZSBmb3IgZWFjaCBtYXRjaGluZyBkb2N1bWVudCwgc2VxdWVudGlhbGx5IGFuZFxuICAgKiAgICAgICAgICBzeW5jaHJvbm91c2x5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCAgZm9yRWFjaFxuICAgKiBAaW5zdGFuY2VcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAcGFyYW0ge0l0ZXJhdGlvbkNhbGxiYWNrfSBjYWxsYmFjayBGdW5jdGlvbiB0byBjYWxsLiBJdCB3aWxsIGJlIGNhbGxlZFxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoIHRocmVlIGFyZ3VtZW50czogdGhlIGRvY3VtZW50LCBhXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAtYmFzZWQgaW5kZXgsIGFuZCA8ZW0+Y3Vyc29yPC9lbT5cbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXRzZWxmLlxuICAgKiBAcGFyYW0ge0FueX0gW3RoaXNBcmddIEFuIG9iamVjdCB3aGljaCB3aWxsIGJlIHRoZSB2YWx1ZSBvZiBgdGhpc2AgaW5zaWRlXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgYGNhbGxiYWNrYC5cbiAgICovXG4gIGZvckVhY2goY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgdGhpcy5fZGVwZW5kKHtcbiAgICAgICAgYWRkZWRCZWZvcmU6IHRydWUsXG4gICAgICAgIHJlbW92ZWQ6IHRydWUsXG4gICAgICAgIGNoYW5nZWQ6IHRydWUsXG4gICAgICAgIG1vdmVkQmVmb3JlOiB0cnVlfSk7XG4gICAgfVxuXG4gICAgdGhpcy5fZ2V0UmF3T2JqZWN0cyh7b3JkZXJlZDogdHJ1ZX0pLmZvckVhY2goKGVsZW1lbnQsIGkpID0+IHtcbiAgICAgIC8vIFRoaXMgZG91YmxlcyBhcyBhIGNsb25lIG9wZXJhdGlvbi5cbiAgICAgIGVsZW1lbnQgPSB0aGlzLl9wcm9qZWN0aW9uRm4oZWxlbWVudCk7XG5cbiAgICAgIGlmICh0aGlzLl90cmFuc2Zvcm0pIHtcbiAgICAgICAgZWxlbWVudCA9IHRoaXMuX3RyYW5zZm9ybShlbGVtZW50KTtcbiAgICAgIH1cblxuICAgICAgY2FsbGJhY2suY2FsbCh0aGlzQXJnLCBlbGVtZW50LCBpLCB0aGlzKTtcbiAgICB9KTtcbiAgfVxuXG4gIGdldFRyYW5zZm9ybSgpIHtcbiAgICByZXR1cm4gdGhpcy5fdHJhbnNmb3JtO1xuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IE1hcCBjYWxsYmFjayBvdmVyIGFsbCBtYXRjaGluZyBkb2N1bWVudHMuICBSZXR1cm5zIGFuIEFycmF5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBtYXBcbiAgICogQGluc3RhbmNlXG4gICAqIEBtZW1iZXJPZiBNb25nby5DdXJzb3JcbiAgICogQHBhcmFtIHtJdGVyYXRpb25DYWxsYmFja30gY2FsbGJhY2sgRnVuY3Rpb24gdG8gY2FsbC4gSXQgd2lsbCBiZSBjYWxsZWRcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aCB0aHJlZSBhcmd1bWVudHM6IHRoZSBkb2N1bWVudCwgYVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAwLWJhc2VkIGluZGV4LCBhbmQgPGVtPmN1cnNvcjwvZW0+XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGl0c2VsZi5cbiAgICogQHBhcmFtIHtBbnl9IFt0aGlzQXJnXSBBbiBvYmplY3Qgd2hpY2ggd2lsbCBiZSB0aGUgdmFsdWUgb2YgYHRoaXNgIGluc2lkZVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgIGBjYWxsYmFja2AuXG4gICAqL1xuICBtYXAoY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBjb25zdCByZXN1bHQgPSBbXTtcblxuICAgIHRoaXMuZm9yRWFjaCgoZG9jLCBpKSA9PiB7XG4gICAgICByZXN1bHQucHVzaChjYWxsYmFjay5jYWxsKHRoaXNBcmcsIGRvYywgaSwgdGhpcykpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIG9wdGlvbnMgdG8gY29udGFpbjpcbiAgLy8gICogY2FsbGJhY2tzIGZvciBvYnNlcnZlKCk6XG4gIC8vICAgIC0gYWRkZWRBdCAoZG9jdW1lbnQsIGF0SW5kZXgpXG4gIC8vICAgIC0gYWRkZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIGNoYW5nZWRBdCAobmV3RG9jdW1lbnQsIG9sZERvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIGNoYW5nZWQgKG5ld0RvY3VtZW50LCBvbGREb2N1bWVudClcbiAgLy8gICAgLSByZW1vdmVkQXQgKGRvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIHJlbW92ZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIG1vdmVkVG8gKGRvY3VtZW50LCBvbGRJbmRleCwgbmV3SW5kZXgpXG4gIC8vXG4gIC8vIGF0dHJpYnV0ZXMgYXZhaWxhYmxlIG9uIHJldHVybmVkIHF1ZXJ5IGhhbmRsZTpcbiAgLy8gICogc3RvcCgpOiBlbmQgdXBkYXRlc1xuICAvLyAgKiBjb2xsZWN0aW9uOiB0aGUgY29sbGVjdGlvbiB0aGlzIHF1ZXJ5IGlzIHF1ZXJ5aW5nXG4gIC8vXG4gIC8vIGlmZiB4IGlzIGEgcmV0dXJuZWQgcXVlcnkgaGFuZGxlLCAoeCBpbnN0YW5jZW9mXG4gIC8vIExvY2FsQ29sbGVjdGlvbi5PYnNlcnZlSGFuZGxlKSBpcyB0cnVlXG4gIC8vXG4gIC8vIGluaXRpYWwgcmVzdWx0cyBkZWxpdmVyZWQgdGhyb3VnaCBhZGRlZCBjYWxsYmFja1xuICAvLyBYWFggbWF5YmUgY2FsbGJhY2tzIHNob3VsZCB0YWtlIGEgbGlzdCBvZiBvYmplY3RzLCB0byBleHBvc2UgdHJhbnNhY3Rpb25zP1xuICAvLyBYWFggbWF5YmUgc3VwcG9ydCBmaWVsZCBsaW1pdGluZyAodG8gbGltaXQgd2hhdCB5b3UncmUgbm90aWZpZWQgb24pXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFdhdGNoIGEgcXVlcnkuICBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZShvcHRpb25zKSB7XG4gICAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyh0aGlzLCBvcHRpb25zKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBXYXRjaCBhIHF1ZXJ5LiBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLiBPbmx5XG4gICAqICAgICAgICAgIHRoZSBkaWZmZXJlbmNlcyBiZXR3ZWVuIHRoZSBvbGQgYW5kIG5ldyBkb2N1bWVudHMgYXJlIHBhc3NlZCB0b1xuICAgKiAgICAgICAgICB0aGUgY2FsbGJhY2tzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZUNoYW5nZXMob3B0aW9ucykge1xuICAgIGNvbnN0IG9yZGVyZWQgPSBMb2NhbENvbGxlY3Rpb24uX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZChvcHRpb25zKTtcblxuICAgIC8vIHRoZXJlIGFyZSBzZXZlcmFsIHBsYWNlcyB0aGF0IGFzc3VtZSB5b3UgYXJlbid0IGNvbWJpbmluZyBza2lwL2xpbWl0IHdpdGhcbiAgICAvLyB1bm9yZGVyZWQgb2JzZXJ2ZS4gIGVnLCB1cGRhdGUncyBFSlNPTi5jbG9uZSwgYW5kIHRoZSBcInRoZXJlIGFyZSBzZXZlcmFsXCJcbiAgICAvLyBjb21tZW50IGluIF9tb2RpZnlBbmROb3RpZnlcbiAgICAvLyBYWFggYWxsb3cgc2tpcC9saW1pdCB3aXRoIHVub3JkZXJlZCBvYnNlcnZlXG4gICAgaWYgKCFvcHRpb25zLl9hbGxvd191bm9yZGVyZWQgJiYgIW9yZGVyZWQgJiYgKHRoaXMuc2tpcCB8fCB0aGlzLmxpbWl0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIk11c3QgdXNlIGFuIG9yZGVyZWQgb2JzZXJ2ZSB3aXRoIHNraXAgb3IgbGltaXQgKGkuZS4gJ2FkZGVkQmVmb3JlJyBcIiArXG4gICAgICAgIFwiZm9yIG9ic2VydmVDaGFuZ2VzIG9yICdhZGRlZEF0JyBmb3Igb2JzZXJ2ZSwgaW5zdGVhZCBvZiAnYWRkZWQnKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5maWVsZHMgJiYgKHRoaXMuZmllbGRzLl9pZCA9PT0gMCB8fCB0aGlzLmZpZWxkcy5faWQgPT09IGZhbHNlKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJ1lvdSBtYXkgbm90IG9ic2VydmUgYSBjdXJzb3Igd2l0aCB7ZmllbGRzOiB7X2lkOiAwfX0nKTtcbiAgICB9XG5cbiAgICBjb25zdCBkaXN0YW5jZXMgPSAoXG4gICAgICB0aGlzLm1hdGNoZXIuaGFzR2VvUXVlcnkoKSAmJlxuICAgICAgb3JkZXJlZCAmJlxuICAgICAgbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXBcbiAgICApO1xuXG4gICAgY29uc3QgcXVlcnkgPSB7XG4gICAgICBjdXJzb3I6IHRoaXMsXG4gICAgICBkaXJ0eTogZmFsc2UsXG4gICAgICBkaXN0YW5jZXMsXG4gICAgICBtYXRjaGVyOiB0aGlzLm1hdGNoZXIsIC8vIG5vdCBmYXN0IHBhdGhlZFxuICAgICAgb3JkZXJlZCxcbiAgICAgIHByb2plY3Rpb25GbjogdGhpcy5fcHJvamVjdGlvbkZuLFxuICAgICAgcmVzdWx0c1NuYXBzaG90OiBudWxsLFxuICAgICAgc29ydGVyOiBvcmRlcmVkICYmIHRoaXMuc29ydGVyXG4gICAgfTtcblxuICAgIGxldCBxaWQ7XG5cbiAgICAvLyBOb24tcmVhY3RpdmUgcXVlcmllcyBjYWxsIGFkZGVkW0JlZm9yZV0gYW5kIHRoZW4gbmV2ZXIgY2FsbCBhbnl0aGluZ1xuICAgIC8vIGVsc2UuXG4gICAgaWYgKHRoaXMucmVhY3RpdmUpIHtcbiAgICAgIHFpZCA9IHRoaXMuY29sbGVjdGlvbi5uZXh0X3FpZCsrO1xuICAgICAgdGhpcy5jb2xsZWN0aW9uLnF1ZXJpZXNbcWlkXSA9IHF1ZXJ5O1xuICAgIH1cblxuICAgIHF1ZXJ5LnJlc3VsdHMgPSB0aGlzLl9nZXRSYXdPYmplY3RzKHtvcmRlcmVkLCBkaXN0YW5jZXM6IHF1ZXJ5LmRpc3RhbmNlc30pO1xuXG4gICAgaWYgKHRoaXMuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IG9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIC8vIHdyYXAgY2FsbGJhY2tzIHdlIHdlcmUgcGFzc2VkLiBjYWxsYmFja3Mgb25seSBmaXJlIHdoZW4gbm90IHBhdXNlZCBhbmRcbiAgICAvLyBhcmUgbmV2ZXIgdW5kZWZpbmVkXG4gICAgLy8gRmlsdGVycyBvdXQgYmxhY2tsaXN0ZWQgZmllbGRzIGFjY29yZGluZyB0byBjdXJzb3IncyBwcm9qZWN0aW9uLlxuICAgIC8vIFhYWCB3cm9uZyBwbGFjZSBmb3IgdGhpcz9cblxuICAgIC8vIGZ1cnRoZXJtb3JlLCBjYWxsYmFja3MgZW5xdWV1ZSB1bnRpbCB0aGUgb3BlcmF0aW9uIHdlJ3JlIHdvcmtpbmcgb24gaXNcbiAgICAvLyBkb25lLlxuICAgIGNvbnN0IHdyYXBDYWxsYmFjayA9IGZuID0+IHtcbiAgICAgIGlmICghZm4pIHtcbiAgICAgICAgcmV0dXJuICgpID0+IHt9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAgIHJldHVybiBmdW5jdGlvbigvKiBhcmdzKi8pIHtcbiAgICAgICAgaWYgKHNlbGYuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBhcmdzID0gYXJndW1lbnRzO1xuXG4gICAgICAgIHNlbGYuY29sbGVjdGlvbi5fb2JzZXJ2ZVF1ZXVlLnF1ZXVlVGFzaygoKSA9PiB7XG4gICAgICAgICAgZm4uYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICB9O1xuXG4gICAgcXVlcnkuYWRkZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5hZGRlZCk7XG4gICAgcXVlcnkuY2hhbmdlZCA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmNoYW5nZWQpO1xuICAgIHF1ZXJ5LnJlbW92ZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5yZW1vdmVkKTtcblxuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZSA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmFkZGVkQmVmb3JlKTtcbiAgICAgIHF1ZXJ5Lm1vdmVkQmVmb3JlID0gd3JhcENhbGxiYWNrKG9wdGlvbnMubW92ZWRCZWZvcmUpO1xuICAgIH1cblxuICAgIGlmICghb3B0aW9ucy5fc3VwcHJlc3NfaW5pdGlhbCAmJiAhdGhpcy5jb2xsZWN0aW9uLnBhdXNlZCkge1xuICAgICAgcXVlcnkucmVzdWx0cy5mb3JFYWNoKGRvYyA9PiB7XG4gICAgICAgIGNvbnN0IGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICAgICAgZGVsZXRlIGZpZWxkcy5faWQ7XG5cbiAgICAgICAgaWYgKG9yZGVyZWQpIHtcbiAgICAgICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSwgbnVsbCk7XG4gICAgICAgIH1cblxuICAgICAgICBxdWVyeS5hZGRlZChkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGUgPSBPYmplY3QuYXNzaWduKG5ldyBMb2NhbENvbGxlY3Rpb24uT2JzZXJ2ZUhhbmRsZSwge1xuICAgICAgY29sbGVjdGlvbjogdGhpcy5jb2xsZWN0aW9uLFxuICAgICAgc3RvcDogKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbGxlY3Rpb24ucXVlcmllc1txaWRdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5yZWFjdGl2ZSAmJiBUcmFja2VyLmFjdGl2ZSkge1xuICAgICAgLy8gWFhYIGluIG1hbnkgY2FzZXMsIHRoZSBzYW1lIG9ic2VydmUgd2lsbCBiZSByZWNyZWF0ZWQgd2hlblxuICAgICAgLy8gdGhlIGN1cnJlbnQgYXV0b3J1biBpcyByZXJ1bi4gIHdlIGNvdWxkIHNhdmUgd29yayBieVxuICAgICAgLy8gbGV0dGluZyBpdCBsaW5nZXIgYWNyb3NzIHJlcnVuIGFuZCBwb3RlbnRpYWxseSBnZXRcbiAgICAgIC8vIHJlcHVycG9zZWQgaWYgdGhlIHNhbWUgb2JzZXJ2ZSBpcyBwZXJmb3JtZWQsIHVzaW5nIGxvZ2ljXG4gICAgICAvLyBzaW1pbGFyIHRvIHRoYXQgb2YgTWV0ZW9yLnN1YnNjcmliZS5cbiAgICAgIFRyYWNrZXIub25JbnZhbGlkYXRlKCgpID0+IHtcbiAgICAgICAgaGFuZGxlLnN0b3AoKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIHJ1biB0aGUgb2JzZXJ2ZSBjYWxsYmFja3MgcmVzdWx0aW5nIGZyb20gdGhlIGluaXRpYWwgY29udGVudHNcbiAgICAvLyBiZWZvcmUgd2UgbGVhdmUgdGhlIG9ic2VydmUuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIHJldHVybiBoYW5kbGU7XG4gIH1cblxuICAvLyBYWFggTWF5YmUgd2UgbmVlZCBhIHZlcnNpb24gb2Ygb2JzZXJ2ZSB0aGF0IGp1c3QgY2FsbHMgYSBjYWxsYmFjayBpZlxuICAvLyBhbnl0aGluZyBjaGFuZ2VkLlxuICBfZGVwZW5kKGNoYW5nZXJzLCBfYWxsb3dfdW5vcmRlcmVkKSB7XG4gICAgaWYgKFRyYWNrZXIuYWN0aXZlKSB7XG4gICAgICBjb25zdCBkZXBlbmRlbmN5ID0gbmV3IFRyYWNrZXIuRGVwZW5kZW5jeTtcbiAgICAgIGNvbnN0IG5vdGlmeSA9IGRlcGVuZGVuY3kuY2hhbmdlZC5iaW5kKGRlcGVuZGVuY3kpO1xuXG4gICAgICBkZXBlbmRlbmN5LmRlcGVuZCgpO1xuXG4gICAgICBjb25zdCBvcHRpb25zID0ge19hbGxvd191bm9yZGVyZWQsIF9zdXBwcmVzc19pbml0aWFsOiB0cnVlfTtcblxuICAgICAgWydhZGRlZCcsICdhZGRlZEJlZm9yZScsICdjaGFuZ2VkJywgJ21vdmVkQmVmb3JlJywgJ3JlbW92ZWQnXVxuICAgICAgICAuZm9yRWFjaChmbiA9PiB7XG4gICAgICAgICAgaWYgKGNoYW5nZXJzW2ZuXSkge1xuICAgICAgICAgICAgb3B0aW9uc1tmbl0gPSBub3RpZnk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgLy8gb2JzZXJ2ZUNoYW5nZXMgd2lsbCBzdG9wKCkgd2hlbiB0aGlzIGNvbXB1dGF0aW9uIGlzIGludmFsaWRhdGVkXG4gICAgICB0aGlzLm9ic2VydmVDaGFuZ2VzKG9wdGlvbnMpO1xuICAgIH1cbiAgfVxuXG4gIF9nZXRDb2xsZWN0aW9uTmFtZSgpIHtcbiAgICByZXR1cm4gdGhpcy5jb2xsZWN0aW9uLm5hbWU7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgY29sbGVjdGlvbiBvZiBtYXRjaGluZyBvYmplY3RzLCBidXQgZG9lc24ndCBkZWVwIGNvcHkgdGhlbS5cbiAgLy9cbiAgLy8gSWYgb3JkZXJlZCBpcyBzZXQsIHJldHVybnMgYSBzb3J0ZWQgYXJyYXksIHJlc3BlY3Rpbmcgc29ydGVyLCBza2lwLCBhbmRcbiAgLy8gbGltaXQgcHJvcGVydGllcyBvZiB0aGUgcXVlcnkgcHJvdmlkZWQgdGhhdCBvcHRpb25zLmFwcGx5U2tpcExpbWl0IGlzXG4gIC8vIG5vdCBzZXQgdG8gZmFsc2UgKCMxMjAxKS4gSWYgc29ydGVyIGlzIGZhbHNleSwgbm8gc29ydCAtLSB5b3UgZ2V0IHRoZVxuICAvLyBuYXR1cmFsIG9yZGVyLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIG5vdCBzZXQsIHJldHVybnMgYW4gb2JqZWN0IG1hcHBpbmcgZnJvbSBJRCB0byBkb2MgKHNvcnRlcixcbiAgLy8gc2tpcCBhbmQgbGltaXQgc2hvdWxkIG5vdCBiZSBzZXQpLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIHNldCBhbmQgdGhpcyBjdXJzb3IgaXMgYSAkbmVhciBnZW9xdWVyeSwgdGhlbiB0aGlzIGZ1bmN0aW9uXG4gIC8vIHdpbGwgdXNlIGFuIF9JZE1hcCB0byB0cmFjayBlYWNoIGRpc3RhbmNlIGZyb20gdGhlICRuZWFyIGFyZ3VtZW50IHBvaW50IGluXG4gIC8vIG9yZGVyIHRvIHVzZSBpdCBhcyBhIHNvcnQga2V5LiBJZiBhbiBfSWRNYXAgaXMgcGFzc2VkIGluIHRoZSAnZGlzdGFuY2VzJ1xuICAvLyBhcmd1bWVudCwgdGhpcyBmdW5jdGlvbiB3aWxsIGNsZWFyIGl0IGFuZCB1c2UgaXQgZm9yIHRoaXMgcHVycG9zZVxuICAvLyAob3RoZXJ3aXNlIGl0IHdpbGwganVzdCBjcmVhdGUgaXRzIG93biBfSWRNYXApLiBUaGUgb2JzZXJ2ZUNoYW5nZXNcbiAgLy8gaW1wbGVtZW50YXRpb24gdXNlcyB0aGlzIHRvIHJlbWVtYmVyIHRoZSBkaXN0YW5jZXMgYWZ0ZXIgdGhpcyBmdW5jdGlvblxuICAvLyByZXR1cm5zLlxuICBfZ2V0UmF3T2JqZWN0cyhvcHRpb25zID0ge30pIHtcbiAgICAvLyBCeSBkZWZhdWx0IHRoaXMgbWV0aG9kIHdpbGwgcmVzcGVjdCBza2lwIGFuZCBsaW1pdCBiZWNhdXNlIC5mZXRjaCgpLFxuICAgIC8vIC5mb3JFYWNoKCkgZXRjLi4uIGV4cGVjdCB0aGlzIGJlaGF2aW91ci4gSXQgY2FuIGJlIGZvcmNlZCB0byBpZ25vcmVcbiAgICAvLyBza2lwIGFuZCBsaW1pdCBieSBzZXR0aW5nIGFwcGx5U2tpcExpbWl0IHRvIGZhbHNlICguY291bnQoKSBkb2VzIHRoaXMsXG4gICAgLy8gZm9yIGV4YW1wbGUpXG4gICAgY29uc3QgYXBwbHlTa2lwTGltaXQgPSBvcHRpb25zLmFwcGx5U2tpcExpbWl0ICE9PSBmYWxzZTtcblxuICAgIC8vIFhYWCB1c2UgT3JkZXJlZERpY3QgaW5zdGVhZCBvZiBhcnJheSwgYW5kIG1ha2UgSWRNYXAgYW5kIE9yZGVyZWREaWN0XG4gICAgLy8gY29tcGF0aWJsZVxuICAgIGNvbnN0IHJlc3VsdHMgPSBvcHRpb25zLm9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuXG4gICAgLy8gZmFzdCBwYXRoIGZvciBzaW5nbGUgSUQgdmFsdWVcbiAgICBpZiAodGhpcy5fc2VsZWN0b3JJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBJZiB5b3UgaGF2ZSBub24temVybyBza2lwIGFuZCBhc2sgZm9yIGEgc2luZ2xlIGlkLCB5b3UgZ2V0IG5vdGhpbmcuXG4gICAgICAvLyBUaGlzIGlzIHNvIGl0IG1hdGNoZXMgdGhlIGJlaGF2aW9yIG9mIHRoZSAne19pZDogZm9vfScgcGF0aC5cbiAgICAgIGlmIChhcHBseVNraXBMaW1pdCAmJiB0aGlzLnNraXApIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNlbGVjdGVkRG9jID0gdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmdldCh0aGlzLl9zZWxlY3RvcklkKTtcblxuICAgICAgaWYgKHNlbGVjdGVkRG9jKSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goc2VsZWN0ZWREb2MpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdHMuc2V0KHRoaXMuX3NlbGVjdG9ySWQsIHNlbGVjdGVkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICAvLyBzbG93IHBhdGggZm9yIGFyYml0cmFyeSBzZWxlY3Rvciwgc29ydCwgc2tpcCwgbGltaXRcblxuICAgIC8vIGluIHRoZSBvYnNlcnZlQ2hhbmdlcyBjYXNlLCBkaXN0YW5jZXMgaXMgYWN0dWFsbHkgcGFydCBvZiB0aGUgXCJxdWVyeVwiXG4gICAgLy8gKGllLCBsaXZlIHJlc3VsdHMgc2V0KSBvYmplY3QuICBpbiBvdGhlciBjYXNlcywgZGlzdGFuY2VzIGlzIG9ubHkgdXNlZFxuICAgIC8vIGluc2lkZSB0aGlzIGZ1bmN0aW9uLlxuICAgIGxldCBkaXN0YW5jZXM7XG4gICAgaWYgKHRoaXMubWF0Y2hlci5oYXNHZW9RdWVyeSgpICYmIG9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgaWYgKG9wdGlvbnMuZGlzdGFuY2VzKSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG9wdGlvbnMuZGlzdGFuY2VzO1xuICAgICAgICBkaXN0YW5jZXMuY2xlYXIoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmZvckVhY2goKGRvYywgaWQpID0+IHtcbiAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gdGhpcy5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAobWF0Y2hSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goZG9jKTtcblxuICAgICAgICAgIGlmIChkaXN0YW5jZXMgJiYgbWF0Y2hSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgZGlzdGFuY2VzLnNldChpZCwgbWF0Y2hSZXN1bHQuZGlzdGFuY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHRzLnNldChpZCwgZG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBPdmVycmlkZSB0byBlbnN1cmUgYWxsIGRvY3MgYXJlIG1hdGNoZWQgaWYgaWdub3Jpbmcgc2tpcCAmIGxpbWl0XG4gICAgICBpZiAoIWFwcGx5U2tpcExpbWl0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBGYXN0IHBhdGggZm9yIGxpbWl0ZWQgdW5zb3J0ZWQgcXVlcmllcy5cbiAgICAgIC8vIFhYWCAnbGVuZ3RoJyBjaGVjayBoZXJlIHNlZW1zIHdyb25nIGZvciBvcmRlcmVkXG4gICAgICByZXR1cm4gKFxuICAgICAgICAhdGhpcy5saW1pdCB8fFxuICAgICAgICB0aGlzLnNraXAgfHxcbiAgICAgICAgdGhpcy5zb3J0ZXIgfHxcbiAgICAgICAgcmVzdWx0cy5sZW5ndGggIT09IHRoaXMubGltaXRcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpZiAoIW9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc29ydGVyKSB7XG4gICAgICByZXN1bHRzLnNvcnQodGhpcy5zb3J0ZXIuZ2V0Q29tcGFyYXRvcih7ZGlzdGFuY2VzfSkpO1xuICAgIH1cblxuICAgIC8vIFJldHVybiB0aGUgZnVsbCBzZXQgb2YgcmVzdWx0cyBpZiB0aGVyZSBpcyBubyBza2lwIG9yIGxpbWl0IG9yIGlmIHdlJ3JlXG4gICAgLy8gaWdub3JpbmcgdGhlbVxuICAgIGlmICghYXBwbHlTa2lwTGltaXQgfHwgKCF0aGlzLmxpbWl0ICYmICF0aGlzLnNraXApKSB7XG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0cy5zbGljZShcbiAgICAgIHRoaXMuc2tpcCxcbiAgICAgIHRoaXMubGltaXQgPyB0aGlzLmxpbWl0ICsgdGhpcy5za2lwIDogcmVzdWx0cy5sZW5ndGhcbiAgICApO1xuICB9XG5cbiAgX3B1Ymxpc2hDdXJzb3Ioc3Vic2NyaXB0aW9uKSB7XG4gICAgLy8gWFhYIG1pbmltb25nbyBzaG91bGQgbm90IGRlcGVuZCBvbiBtb25nby1saXZlZGF0YSFcbiAgICBpZiAoIVBhY2thZ2UubW9uZ28pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ0NhblxcJ3QgcHVibGlzaCBmcm9tIE1pbmltb25nbyB3aXRob3V0IHRoZSBgbW9uZ29gIHBhY2thZ2UuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuY29sbGVjdGlvbi5uYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdDYW5cXCd0IHB1Ymxpc2ggYSBjdXJzb3IgZnJvbSBhIGNvbGxlY3Rpb24gd2l0aG91dCBhIG5hbWUuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gUGFja2FnZS5tb25nby5Nb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKFxuICAgICAgdGhpcyxcbiAgICAgIHN1YnNjcmlwdGlvbixcbiAgICAgIHRoaXMuY29sbGVjdGlvbi5uYW1lXG4gICAgKTtcbiAgfVxufVxuXG4vLyBJbXBsZW1lbnRzIGFzeW5jIHZlcnNpb24gb2YgY3Vyc29yIG1ldGhvZHMgdG8ga2VlcCBjb2xsZWN0aW9ucyBpc29tb3JwaGljXG5BU1lOQ19DVVJTT1JfTUVUSE9EUy5mb3JFYWNoKG1ldGhvZCA9PiB7XG4gIGNvbnN0IGFzeW5jTmFtZSA9IGdldEFzeW5jTWV0aG9kTmFtZShtZXRob2QpO1xuICBDdXJzb3IucHJvdG90eXBlW2FzeW5jTmFtZV0gPSBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodGhpc1ttZXRob2RdLmFwcGx5KHRoaXMsIGFyZ3MpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycm9yKTtcbiAgICB9XG4gIH07XG59KTtcbiIsImltcG9ydCBDdXJzb3IgZnJvbSAnLi9jdXJzb3IuanMnO1xuaW1wb3J0IE9ic2VydmVIYW5kbGUgZnJvbSAnLi9vYnNlcnZlX2hhbmRsZS5qcyc7XG5pbXBvcnQge1xuICBoYXNPd24sXG4gIGlzSW5kZXhhYmxlLFxuICBpc051bWVyaWNLZXksXG4gIGlzT3BlcmF0b3JPYmplY3QsXG4gIHBvcHVsYXRlRG9jdW1lbnRXaXRoUXVlcnlGaWVsZHMsXG4gIHByb2plY3Rpb25EZXRhaWxzLFxufSBmcm9tICcuL2NvbW1vbi5qcyc7XG5cbi8vIFhYWCB0eXBlIGNoZWNraW5nIG9uIHNlbGVjdG9ycyAoZ3JhY2VmdWwgZXJyb3IgaWYgbWFsZm9ybWVkKVxuXG4vLyBMb2NhbENvbGxlY3Rpb246IGEgc2V0IG9mIGRvY3VtZW50cyB0aGF0IHN1cHBvcnRzIHF1ZXJpZXMgYW5kIG1vZGlmaWVycy5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIExvY2FsQ29sbGVjdGlvbiB7XG4gIGNvbnN0cnVjdG9yKG5hbWUpIHtcbiAgICB0aGlzLm5hbWUgPSBuYW1lO1xuICAgIC8vIF9pZCAtPiBkb2N1bWVudCAoYWxzbyBjb250YWluaW5nIGlkKVxuICAgIHRoaXMuX2RvY3MgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcblxuICAgIHRoaXMuX29ic2VydmVRdWV1ZSA9IG5ldyBNZXRlb3IuX1N5bmNocm9ub3VzUXVldWUoKTtcblxuICAgIHRoaXMubmV4dF9xaWQgPSAxOyAvLyBsaXZlIHF1ZXJ5IGlkIGdlbmVyYXRvclxuXG4gICAgLy8gcWlkIC0+IGxpdmUgcXVlcnkgb2JqZWN0LiBrZXlzOlxuICAgIC8vICBvcmRlcmVkOiBib29sLiBvcmRlcmVkIHF1ZXJpZXMgaGF2ZSBhZGRlZEJlZm9yZS9tb3ZlZEJlZm9yZSBjYWxsYmFja3MuXG4gICAgLy8gIHJlc3VsdHM6IGFycmF5IChvcmRlcmVkKSBvciBvYmplY3QgKHVub3JkZXJlZCkgb2YgY3VycmVudCByZXN1bHRzXG4gICAgLy8gICAgKGFsaWFzZWQgd2l0aCB0aGlzLl9kb2NzISlcbiAgICAvLyAgcmVzdWx0c1NuYXBzaG90OiBzbmFwc2hvdCBvZiByZXN1bHRzLiBudWxsIGlmIG5vdCBwYXVzZWQuXG4gICAgLy8gIGN1cnNvcjogQ3Vyc29yIG9iamVjdCBmb3IgdGhlIHF1ZXJ5LlxuICAgIC8vICBzZWxlY3Rvciwgc29ydGVyLCAoY2FsbGJhY2tzKTogZnVuY3Rpb25zXG4gICAgdGhpcy5xdWVyaWVzID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuICAgIC8vIG51bGwgaWYgbm90IHNhdmluZyBvcmlnaW5hbHM7IGFuIElkTWFwIGZyb20gaWQgdG8gb3JpZ2luYWwgZG9jdW1lbnQgdmFsdWVcbiAgICAvLyBpZiBzYXZpbmcgb3JpZ2luYWxzLiBTZWUgY29tbWVudHMgYmVmb3JlIHNhdmVPcmlnaW5hbHMoKS5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscyA9IG51bGw7XG5cbiAgICAvLyBUcnVlIHdoZW4gb2JzZXJ2ZXJzIGFyZSBwYXVzZWQgYW5kIHdlIHNob3VsZCBub3Qgc2VuZCBjYWxsYmFja3MuXG4gICAgdGhpcy5wYXVzZWQgPSBmYWxzZTtcbiAgfVxuXG4gIGNvdW50RG9jdW1lbnRzKHNlbGVjdG9yLCBvcHRpb25zKSB7XG4gICAgcmV0dXJuIHRoaXMuZmluZChzZWxlY3RvciA/PyB7fSwgb3B0aW9ucykuY291bnRBc3luYygpO1xuICB9XG5cbiAgZXN0aW1hdGVkRG9jdW1lbnRDb3VudChvcHRpb25zKSB7XG4gICAgcmV0dXJuIHRoaXMuZmluZCh7fSwgb3B0aW9ucykuY291bnRBc3luYygpO1xuICB9XG5cbiAgLy8gb3B0aW9ucyBtYXkgaW5jbHVkZSBzb3J0LCBza2lwLCBsaW1pdCwgcmVhY3RpdmVcbiAgLy8gc29ydCBtYXkgYmUgYW55IG9mIHRoZXNlIGZvcm1zOlxuICAvLyAgICAge2E6IDEsIGI6IC0xfVxuICAvLyAgICAgW1tcImFcIiwgXCJhc2NcIl0sIFtcImJcIiwgXCJkZXNjXCJdXVxuICAvLyAgICAgW1wiYVwiLCBbXCJiXCIsIFwiZGVzY1wiXV1cbiAgLy8gICAoaW4gdGhlIGZpcnN0IGZvcm0geW91J3JlIGJlaG9sZGVuIHRvIGtleSBlbnVtZXJhdGlvbiBvcmRlciBpblxuICAvLyAgIHlvdXIgamF2YXNjcmlwdCBWTSlcbiAgLy9cbiAgLy8gcmVhY3RpdmU6IGlmIGdpdmVuLCBhbmQgZmFsc2UsIGRvbid0IHJlZ2lzdGVyIHdpdGggVHJhY2tlciAoZGVmYXVsdFxuICAvLyBpcyB0cnVlKVxuICAvL1xuICAvLyBYWFggcG9zc2libHkgc2hvdWxkIHN1cHBvcnQgcmV0cmlldmluZyBhIHN1YnNldCBvZiBmaWVsZHM/IGFuZFxuICAvLyBoYXZlIGl0IGJlIGEgaGludCAoaWdub3JlZCBvbiB0aGUgY2xpZW50LCB3aGVuIG5vdCBjb3B5aW5nIHRoZVxuICAvLyBkb2M/KVxuICAvL1xuICAvLyBYWFggc29ydCBkb2VzIG5vdCB5ZXQgc3VwcG9ydCBzdWJrZXlzICgnYS5iJykgLi4gZml4IHRoYXQhXG4gIC8vIFhYWCBhZGQgb25lIG1vcmUgc29ydCBmb3JtOiBcImtleVwiXG4gIC8vIFhYWCB0ZXN0c1xuICBmaW5kKHNlbGVjdG9yLCBvcHRpb25zKSB7XG4gICAgLy8gZGVmYXVsdCBzeW50YXggZm9yIGV2ZXJ5dGhpbmcgaXMgdG8gb21pdCB0aGUgc2VsZWN0b3IgYXJndW1lbnQuXG4gICAgLy8gYnV0IGlmIHNlbGVjdG9yIGlzIGV4cGxpY2l0bHkgcGFzc2VkIGluIGFzIGZhbHNlIG9yIHVuZGVmaW5lZCwgd2VcbiAgICAvLyB3YW50IGEgc2VsZWN0b3IgdGhhdCBtYXRjaGVzIG5vdGhpbmcuXG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHNlbGVjdG9yID0ge307XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBMb2NhbENvbGxlY3Rpb24uQ3Vyc29yKHRoaXMsIHNlbGVjdG9yLCBvcHRpb25zKTtcbiAgfVxuXG4gIGZpbmRPbmUoc2VsZWN0b3IsIG9wdGlvbnMgPSB7fSkge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBzZWxlY3RvciA9IHt9O1xuICAgIH1cblxuICAgIC8vIE5PVEU6IGJ5IHNldHRpbmcgbGltaXQgMSBoZXJlLCB3ZSBlbmQgdXAgdXNpbmcgdmVyeSBpbmVmZmljaWVudFxuICAgIC8vIGNvZGUgdGhhdCByZWNvbXB1dGVzIHRoZSB3aG9sZSBxdWVyeSBvbiBlYWNoIHVwZGF0ZS4gVGhlIHVwc2lkZSBpc1xuICAgIC8vIHRoYXQgd2hlbiB5b3UgcmVhY3RpdmVseSBkZXBlbmQgb24gYSBmaW5kT25lIHlvdSBvbmx5IGdldFxuICAgIC8vIGludmFsaWRhdGVkIHdoZW4gdGhlIGZvdW5kIG9iamVjdCBjaGFuZ2VzLCBub3QgYW55IG9iamVjdCBpbiB0aGVcbiAgICAvLyBjb2xsZWN0aW9uLiBNb3N0IGZpbmRPbmUgd2lsbCBiZSBieSBpZCwgd2hpY2ggaGFzIGEgZmFzdCBwYXRoLCBzb1xuICAgIC8vIHRoaXMgbWlnaHQgbm90IGJlIGEgYmlnIGRlYWwuIEluIG1vc3QgY2FzZXMsIGludmFsaWRhdGlvbiBjYXVzZXNcbiAgICAvLyB0aGUgY2FsbGVkIHRvIHJlLXF1ZXJ5IGFueXdheSwgc28gdGhpcyBzaG91bGQgYmUgYSBuZXQgcGVyZm9ybWFuY2VcbiAgICAvLyBpbXByb3ZlbWVudC5cbiAgICBvcHRpb25zLmxpbWl0ID0gMTtcblxuICAgIHJldHVybiB0aGlzLmZpbmQoc2VsZWN0b3IsIG9wdGlvbnMpLmZldGNoKClbMF07XG4gIH1cblxuICAvLyBYWFggcG9zc2libHkgZW5mb3JjZSB0aGF0ICd1bmRlZmluZWQnIGRvZXMgbm90IGFwcGVhciAod2UgYXNzdW1lXG4gIC8vIHRoaXMgaW4gb3VyIGhhbmRsaW5nIG9mIG51bGwgYW5kICRleGlzdHMpXG4gIGluc2VydChkb2MsIGNhbGxiYWNrKSB7XG4gICAgZG9jID0gRUpTT04uY2xvbmUoZG9jKTtcblxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhkb2MpO1xuXG4gICAgLy8gaWYgeW91IHJlYWxseSB3YW50IHRvIHVzZSBPYmplY3RJRHMsIHNldCB0aGlzIGdsb2JhbC5cbiAgICAvLyBNb25nby5Db2xsZWN0aW9uIHNwZWNpZmllcyBpdHMgb3duIGlkcyBhbmQgZG9lcyBub3QgdXNlIHRoaXMgY29kZS5cbiAgICBpZiAoIWhhc093bi5jYWxsKGRvYywgJ19pZCcpKSB7XG4gICAgICBkb2MuX2lkID0gTG9jYWxDb2xsZWN0aW9uLl91c2VPSUQgPyBuZXcgTW9uZ29JRC5PYmplY3RJRCgpIDogUmFuZG9tLmlkKCk7XG4gICAgfVxuXG4gICAgY29uc3QgaWQgPSBkb2MuX2lkO1xuXG4gICAgaWYgKHRoaXMuX2RvY3MuaGFzKGlkKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoYER1cGxpY2F0ZSBfaWQgJyR7aWR9J2ApO1xuICAgIH1cblxuICAgIHRoaXMuX3NhdmVPcmlnaW5hbChpZCwgdW5kZWZpbmVkKTtcbiAgICB0aGlzLl9kb2NzLnNldChpZCwgZG9jKTtcblxuICAgIGNvbnN0IHF1ZXJpZXNUb1JlY29tcHV0ZSA9IFtdO1xuXG4gICAgLy8gdHJpZ2dlciBsaXZlIHF1ZXJpZXMgdGhhdCBtYXRjaFxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBxdWVyeS5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAobWF0Y2hSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIGlmIChxdWVyeS5kaXN0YW5jZXMgJiYgbWF0Y2hSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHF1ZXJ5LmRpc3RhbmNlcy5zZXQoaWQsIG1hdGNoUmVzdWx0LmRpc3RhbmNlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChxdWVyeS5jdXJzb3Iuc2tpcCB8fCBxdWVyeS5jdXJzb3IubGltaXQpIHtcbiAgICAgICAgICBxdWVyaWVzVG9SZWNvbXB1dGUucHVzaChxaWQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIExvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5SZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBxdWVyaWVzVG9SZWNvbXB1dGUuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgaWYgKHRoaXMucXVlcmllc1txaWRdKSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHModGhpcy5xdWVyaWVzW3FpZF0pO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICAvLyBEZWZlciBiZWNhdXNlIHRoZSBjYWxsZXIgbGlrZWx5IGRvZXNuJ3QgZXhwZWN0IHRoZSBjYWxsYmFjayB0byBiZSBydW5cbiAgICAvLyBpbW1lZGlhdGVseS5cbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIE1ldGVvci5kZWZlcigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIGlkKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIC8vIFBhdXNlIHRoZSBvYnNlcnZlcnMuIE5vIGNhbGxiYWNrcyBmcm9tIG9ic2VydmVycyB3aWxsIGZpcmUgdW50aWxcbiAgLy8gJ3Jlc3VtZU9ic2VydmVycycgaXMgY2FsbGVkLlxuICBwYXVzZU9ic2VydmVycygpIHtcbiAgICAvLyBOby1vcCBpZiBhbHJlYWR5IHBhdXNlZC5cbiAgICBpZiAodGhpcy5wYXVzZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTZXQgdGhlICdwYXVzZWQnIGZsYWcgc3VjaCB0aGF0IG5ldyBvYnNlcnZlciBtZXNzYWdlcyBkb24ndCBmaXJlLlxuICAgIHRoaXMucGF1c2VkID0gdHJ1ZTtcblxuICAgIC8vIFRha2UgYSBzbmFwc2hvdCBvZiB0aGUgcXVlcnkgcmVzdWx0cyBmb3IgZWFjaCBxdWVyeS5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG4gICAgICBxdWVyeS5yZXN1bHRzU25hcHNob3QgPSBFSlNPTi5jbG9uZShxdWVyeS5yZXN1bHRzKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJlbW92ZShzZWxlY3RvciwgY2FsbGJhY2spIHtcbiAgICAvLyBFYXN5IHNwZWNpYWwgY2FzZTogaWYgd2UncmUgbm90IGNhbGxpbmcgb2JzZXJ2ZUNoYW5nZXMgY2FsbGJhY2tzIGFuZFxuICAgIC8vIHdlJ3JlIG5vdCBzYXZpbmcgb3JpZ2luYWxzIGFuZCB3ZSBnb3QgYXNrZWQgdG8gcmVtb3ZlIGV2ZXJ5dGhpbmcsIHRoZW5cbiAgICAvLyBqdXN0IGVtcHR5IGV2ZXJ5dGhpbmcgZGlyZWN0bHkuXG4gICAgaWYgKHRoaXMucGF1c2VkICYmICF0aGlzLl9zYXZlZE9yaWdpbmFscyAmJiBFSlNPTi5lcXVhbHMoc2VsZWN0b3IsIHt9KSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fZG9jcy5zaXplKCk7XG5cbiAgICAgIHRoaXMuX2RvY3MuY2xlYXIoKTtcblxuICAgICAgT2JqZWN0LmtleXModGhpcy5xdWVyaWVzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgICAgaWYgKHF1ZXJ5Lm9yZGVyZWQpIHtcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzID0gW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcXVlcnkucmVzdWx0cy5jbGVhcigpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIE1ldGVvci5kZWZlcigoKSA9PiB7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3Rvcik7XG4gICAgY29uc3QgcmVtb3ZlID0gW107XG5cbiAgICB0aGlzLl9lYWNoUG9zc2libHlNYXRjaGluZ0RvYyhzZWxlY3RvciwgKGRvYywgaWQpID0+IHtcbiAgICAgIGlmIChtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpLnJlc3VsdCkge1xuICAgICAgICByZW1vdmUucHVzaChpZCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb25zdCBxdWVyaWVzVG9SZWNvbXB1dGUgPSBbXTtcbiAgICBjb25zdCBxdWVyeVJlbW92ZSA9IFtdO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCByZW1vdmUubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHJlbW92ZUlkID0gcmVtb3ZlW2ldO1xuICAgICAgY29uc3QgcmVtb3ZlRG9jID0gdGhpcy5fZG9jcy5nZXQocmVtb3ZlSWQpO1xuXG4gICAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgICBpZiAocXVlcnkuZGlydHkpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocXVlcnkubWF0Y2hlci5kb2N1bWVudE1hdGNoZXMocmVtb3ZlRG9jKS5yZXN1bHQpIHtcbiAgICAgICAgICBpZiAocXVlcnkuY3Vyc29yLnNraXAgfHwgcXVlcnkuY3Vyc29yLmxpbWl0KSB7XG4gICAgICAgICAgICBxdWVyaWVzVG9SZWNvbXB1dGUucHVzaChxaWQpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBxdWVyeVJlbW92ZS5wdXNoKHtxaWQsIGRvYzogcmVtb3ZlRG9jfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5fc2F2ZU9yaWdpbmFsKHJlbW92ZUlkLCByZW1vdmVEb2MpO1xuICAgICAgdGhpcy5fZG9jcy5yZW1vdmUocmVtb3ZlSWQpO1xuICAgIH1cblxuICAgIC8vIHJ1biBsaXZlIHF1ZXJ5IGNhbGxiYWNrcyBfYWZ0ZXJfIHdlJ3ZlIHJlbW92ZWQgdGhlIGRvY3VtZW50cy5cbiAgICBxdWVyeVJlbW92ZS5mb3JFYWNoKHJlbW92ZSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1tyZW1vdmUucWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHF1ZXJ5LmRpc3RhbmNlcyAmJiBxdWVyeS5kaXN0YW5jZXMucmVtb3ZlKHJlbW92ZS5kb2MuX2lkKTtcbiAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9yZW1vdmVGcm9tUmVzdWx0cyhxdWVyeSwgcmVtb3ZlLmRvYyk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBxdWVyaWVzVG9SZWNvbXB1dGUuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHMocXVlcnkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZW1vdmUubGVuZ3RoO1xuXG4gICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICBNZXRlb3IuZGVmZXIoKCkgPT4ge1xuICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIFJlc3VtZSB0aGUgb2JzZXJ2ZXJzLiBPYnNlcnZlcnMgaW1tZWRpYXRlbHkgcmVjZWl2ZSBjaGFuZ2VcbiAgLy8gbm90aWZpY2F0aW9ucyB0byBicmluZyB0aGVtIHRvIHRoZSBjdXJyZW50IHN0YXRlIG9mIHRoZVxuICAvLyBkYXRhYmFzZS4gTm90ZSB0aGF0IHRoaXMgaXMgbm90IGp1c3QgcmVwbGF5aW5nIGFsbCB0aGUgY2hhbmdlcyB0aGF0XG4gIC8vIGhhcHBlbmVkIGR1cmluZyB0aGUgcGF1c2UsIGl0IGlzIGEgc21hcnRlciAnY29hbGVzY2VkJyBkaWZmLlxuICByZXN1bWVPYnNlcnZlcnMoKSB7XG4gICAgLy8gTm8tb3AgaWYgbm90IHBhdXNlZC5cbiAgICBpZiAoIXRoaXMucGF1c2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gVW5zZXQgdGhlICdwYXVzZWQnIGZsYWcuIE1ha2Ugc3VyZSB0byBkbyB0aGlzIGZpcnN0LCBvdGhlcndpc2VcbiAgICAvLyBvYnNlcnZlciBtZXRob2RzIHdvbid0IGFjdHVhbGx5IGZpcmUgd2hlbiB3ZSB0cmlnZ2VyIHRoZW0uXG4gICAgdGhpcy5wYXVzZWQgPSBmYWxzZTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHF1ZXJ5LmRpcnR5ID0gZmFsc2U7XG5cbiAgICAgICAgLy8gcmUtY29tcHV0ZSByZXN1bHRzIHdpbGwgcGVyZm9ybSBgTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzYFxuICAgICAgICAvLyBhdXRvbWF0aWNhbGx5LlxuICAgICAgICB0aGlzLl9yZWNvbXB1dGVSZXN1bHRzKHF1ZXJ5LCBxdWVyeS5yZXN1bHRzU25hcHNob3QpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRGlmZiB0aGUgY3VycmVudCByZXN1bHRzIGFnYWluc3QgdGhlIHNuYXBzaG90IGFuZCBzZW5kIHRvIG9ic2VydmVycy5cbiAgICAgICAgLy8gcGFzcyB0aGUgcXVlcnkgb2JqZWN0IGZvciBpdHMgb2JzZXJ2ZXIgY2FsbGJhY2tzLlxuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeUNoYW5nZXMoXG4gICAgICAgICAgcXVlcnkub3JkZXJlZCxcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzU25hcHNob3QsXG4gICAgICAgICAgcXVlcnkucmVzdWx0cyxcbiAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICB7cHJvamVjdGlvbkZuOiBxdWVyeS5wcm9qZWN0aW9uRm59XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IG51bGw7XG4gICAgfSk7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcbiAgfVxuXG4gIHJldHJpZXZlT3JpZ2luYWxzKCkge1xuICAgIGlmICghdGhpcy5fc2F2ZWRPcmlnaW5hbHMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2FsbGVkIHJldHJpZXZlT3JpZ2luYWxzIHdpdGhvdXQgc2F2ZU9yaWdpbmFscycpO1xuICAgIH1cblxuICAgIGNvbnN0IG9yaWdpbmFscyA9IHRoaXMuX3NhdmVkT3JpZ2luYWxzO1xuXG4gICAgdGhpcy5fc2F2ZWRPcmlnaW5hbHMgPSBudWxsO1xuXG4gICAgcmV0dXJuIG9yaWdpbmFscztcbiAgfVxuXG4gIC8vIFRvIHRyYWNrIHdoYXQgZG9jdW1lbnRzIGFyZSBhZmZlY3RlZCBieSBhIHBpZWNlIG9mIGNvZGUsIGNhbGxcbiAgLy8gc2F2ZU9yaWdpbmFscygpIGJlZm9yZSBpdCBhbmQgcmV0cmlldmVPcmlnaW5hbHMoKSBhZnRlciBpdC5cbiAgLy8gcmV0cmlldmVPcmlnaW5hbHMgcmV0dXJucyBhbiBvYmplY3Qgd2hvc2Uga2V5cyBhcmUgdGhlIGlkcyBvZiB0aGUgZG9jdW1lbnRzXG4gIC8vIHRoYXQgd2VyZSBhZmZlY3RlZCBzaW5jZSB0aGUgY2FsbCB0byBzYXZlT3JpZ2luYWxzKCksIGFuZCB0aGUgdmFsdWVzIGFyZVxuICAvLyBlcXVhbCB0byB0aGUgZG9jdW1lbnQncyBjb250ZW50cyBhdCB0aGUgdGltZSBvZiBzYXZlT3JpZ2luYWxzLiAoSW4gdGhlIGNhc2VcbiAgLy8gb2YgYW4gaW5zZXJ0ZWQgZG9jdW1lbnQsIHVuZGVmaW5lZCBpcyB0aGUgdmFsdWUuKSBZb3UgbXVzdCBhbHRlcm5hdGVcbiAgLy8gYmV0d2VlbiBjYWxscyB0byBzYXZlT3JpZ2luYWxzKCkgYW5kIHJldHJpZXZlT3JpZ2luYWxzKCkuXG4gIHNhdmVPcmlnaW5hbHMoKSB7XG4gICAgaWYgKHRoaXMuX3NhdmVkT3JpZ2luYWxzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NhbGxlZCBzYXZlT3JpZ2luYWxzIHR3aWNlIHdpdGhvdXQgcmV0cmlldmVPcmlnaW5hbHMnKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICB9XG5cbiAgLy8gWFhYIGF0b21pY2l0eTogaWYgbXVsdGkgaXMgdHJ1ZSwgYW5kIG9uZSBtb2RpZmljYXRpb24gZmFpbHMsIGRvXG4gIC8vIHdlIHJvbGxiYWNrIHRoZSB3aG9sZSBvcGVyYXRpb24sIG9yIHdoYXQ/XG4gIHVwZGF0ZShzZWxlY3RvciwgbW9kLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICAgIGlmICghIGNhbGxiYWNrICYmIG9wdGlvbnMgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IG51bGw7XG4gICAgfVxuXG4gICAgaWYgKCFvcHRpb25zKSB7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfVxuXG4gICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3RvciwgdHJ1ZSk7XG5cbiAgICAvLyBTYXZlIHRoZSBvcmlnaW5hbCByZXN1bHRzIG9mIGFueSBxdWVyeSB0aGF0IHdlIG1pZ2h0IG5lZWQgdG9cbiAgICAvLyBfcmVjb21wdXRlUmVzdWx0cyBvbiwgYmVjYXVzZSBfbW9kaWZ5QW5kTm90aWZ5IHdpbGwgbXV0YXRlIHRoZSBvYmplY3RzIGluXG4gICAgLy8gaXQuIChXZSBkb24ndCBuZWVkIHRvIHNhdmUgdGhlIG9yaWdpbmFsIHJlc3VsdHMgb2YgcGF1c2VkIHF1ZXJpZXMgYmVjYXVzZVxuICAgIC8vIHRoZXkgYWxyZWFkeSBoYXZlIGEgcmVzdWx0c1NuYXBzaG90IGFuZCB3ZSB3b24ndCBiZSBkaWZmaW5nIGluXG4gICAgLy8gX3JlY29tcHV0ZVJlc3VsdHMuKVxuICAgIGNvbnN0IHFpZFRvT3JpZ2luYWxSZXN1bHRzID0ge307XG5cbiAgICAvLyBXZSBzaG91bGQgb25seSBjbG9uZSBlYWNoIGRvY3VtZW50IG9uY2UsIGV2ZW4gaWYgaXQgYXBwZWFycyBpbiBtdWx0aXBsZVxuICAgIC8vIHF1ZXJpZXNcbiAgICBjb25zdCBkb2NNYXAgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICBjb25zdCBpZHNNYXRjaGVkID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgIGlmICgocXVlcnkuY3Vyc29yLnNraXAgfHwgcXVlcnkuY3Vyc29yLmxpbWl0KSAmJiAhIHRoaXMucGF1c2VkKSB7XG4gICAgICAgIC8vIENhdGNoIHRoZSBjYXNlIG9mIGEgcmVhY3RpdmUgYGNvdW50KClgIG9uIGEgY3Vyc29yIHdpdGggc2tpcFxuICAgICAgICAvLyBvciBsaW1pdCwgd2hpY2ggcmVnaXN0ZXJzIGFuIHVub3JkZXJlZCBvYnNlcnZlLiBUaGlzIGlzIGFcbiAgICAgICAgLy8gcHJldHR5IHJhcmUgY2FzZSwgc28gd2UganVzdCBjbG9uZSB0aGUgZW50aXJlIHJlc3VsdCBzZXQgd2l0aFxuICAgICAgICAvLyBubyBvcHRpbWl6YXRpb25zIGZvciBkb2N1bWVudHMgdGhhdCBhcHBlYXIgaW4gdGhlc2UgcmVzdWx0XG4gICAgICAgIC8vIHNldHMgYW5kIG90aGVyIHF1ZXJpZXMuXG4gICAgICAgIGlmIChxdWVyeS5yZXN1bHRzIGluc3RhbmNlb2YgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcCkge1xuICAgICAgICAgIHFpZFRvT3JpZ2luYWxSZXN1bHRzW3FpZF0gPSBxdWVyeS5yZXN1bHRzLmNsb25lKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCEocXVlcnkucmVzdWx0cyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQXNzZXJ0aW9uIGZhaWxlZDogcXVlcnkucmVzdWx0cyBub3QgYW4gYXJyYXknKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENsb25lcyBhIGRvY3VtZW50IHRvIGJlIHN0b3JlZCBpbiBgcWlkVG9PcmlnaW5hbFJlc3VsdHNgXG4gICAgICAgIC8vIGJlY2F1c2UgaXQgbWF5IGJlIG1vZGlmaWVkIGJlZm9yZSB0aGUgbmV3IGFuZCBvbGQgcmVzdWx0IHNldHNcbiAgICAgICAgLy8gYXJlIGRpZmZlZC4gQnV0IGlmIHdlIGtub3cgZXhhY3RseSB3aGljaCBkb2N1bWVudCBJRHMgd2UncmVcbiAgICAgICAgLy8gZ29pbmcgdG8gbW9kaWZ5LCB0aGVuIHdlIG9ubHkgbmVlZCB0byBjbG9uZSB0aG9zZS5cbiAgICAgICAgY29uc3QgbWVtb2l6ZWRDbG9uZUlmTmVlZGVkID0gZG9jID0+IHtcbiAgICAgICAgICBpZiAoZG9jTWFwLmhhcyhkb2MuX2lkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGRvY01hcC5nZXQoZG9jLl9pZCk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgZG9jVG9NZW1vaXplID0gKFxuICAgICAgICAgICAgaWRzTWF0Y2hlZCAmJlxuICAgICAgICAgICAgIWlkc01hdGNoZWQuc29tZShpZCA9PiBFSlNPTi5lcXVhbHMoaWQsIGRvYy5faWQpKVxuICAgICAgICAgICkgPyBkb2MgOiBFSlNPTi5jbG9uZShkb2MpO1xuXG4gICAgICAgICAgZG9jTWFwLnNldChkb2MuX2lkLCBkb2NUb01lbW9pemUpO1xuXG4gICAgICAgICAgcmV0dXJuIGRvY1RvTWVtb2l6ZTtcbiAgICAgICAgfTtcblxuICAgICAgICBxaWRUb09yaWdpbmFsUmVzdWx0c1txaWRdID0gcXVlcnkucmVzdWx0cy5tYXAobWVtb2l6ZWRDbG9uZUlmTmVlZGVkKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IHJlY29tcHV0ZVFpZHMgPSB7fTtcblxuICAgIGxldCB1cGRhdGVDb3VudCA9IDA7XG5cbiAgICB0aGlzLl9lYWNoUG9zc2libHlNYXRjaGluZ0RvYyhzZWxlY3RvciwgKGRvYywgaWQpID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoZG9jKTtcblxuICAgICAgaWYgKHF1ZXJ5UmVzdWx0LnJlc3VsdCkge1xuICAgICAgICAvLyBYWFggU2hvdWxkIHdlIHNhdmUgdGhlIG9yaWdpbmFsIGV2ZW4gaWYgbW9kIGVuZHMgdXAgYmVpbmcgYSBuby1vcD9cbiAgICAgICAgdGhpcy5fc2F2ZU9yaWdpbmFsKGlkLCBkb2MpO1xuICAgICAgICB0aGlzLl9tb2RpZnlBbmROb3RpZnkoXG4gICAgICAgICAgZG9jLFxuICAgICAgICAgIG1vZCxcbiAgICAgICAgICByZWNvbXB1dGVRaWRzLFxuICAgICAgICAgIHF1ZXJ5UmVzdWx0LmFycmF5SW5kaWNlc1xuICAgICAgICApO1xuXG4gICAgICAgICsrdXBkYXRlQ291bnQ7XG5cbiAgICAgICAgaWYgKCFvcHRpb25zLm11bHRpKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyBicmVha1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuXG4gICAgT2JqZWN0LmtleXMocmVjb21wdXRlUWlkcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHMocXVlcnksIHFpZFRvT3JpZ2luYWxSZXN1bHRzW3FpZF0pO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICAvLyBJZiB3ZSBhcmUgZG9pbmcgYW4gdXBzZXJ0LCBhbmQgd2UgZGlkbid0IG1vZGlmeSBhbnkgZG9jdW1lbnRzIHlldCwgdGhlblxuICAgIC8vIGl0J3MgdGltZSB0byBkbyBhbiBpbnNlcnQuIEZpZ3VyZSBvdXQgd2hhdCBkb2N1bWVudCB3ZSBhcmUgaW5zZXJ0aW5nLCBhbmRcbiAgICAvLyBnZW5lcmF0ZSBhbiBpZCBmb3IgaXQuXG4gICAgbGV0IGluc2VydGVkSWQ7XG4gICAgaWYgKHVwZGF0ZUNvdW50ID09PSAwICYmIG9wdGlvbnMudXBzZXJ0KSB7XG4gICAgICBjb25zdCBkb2MgPSBMb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50KHNlbGVjdG9yLCBtb2QpO1xuICAgICAgaWYgKCEgZG9jLl9pZCAmJiBvcHRpb25zLmluc2VydGVkSWQpIHtcbiAgICAgICAgZG9jLl9pZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgIH1cblxuICAgICAgaW5zZXJ0ZWRJZCA9IHRoaXMuaW5zZXJ0KGRvYyk7XG4gICAgICB1cGRhdGVDb3VudCA9IDE7XG4gICAgfVxuXG4gICAgLy8gUmV0dXJuIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jdW1lbnRzLCBvciBpbiB0aGUgdXBzZXJ0IGNhc2UsIGFuIG9iamVjdFxuICAgIC8vIGNvbnRhaW5pbmcgdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2NzIGFuZCB0aGUgaWQgb2YgdGhlIGRvYyB0aGF0IHdhc1xuICAgIC8vIGluc2VydGVkLCBpZiBhbnkuXG4gICAgbGV0IHJlc3VsdDtcbiAgICBpZiAob3B0aW9ucy5fcmV0dXJuT2JqZWN0KSB7XG4gICAgICByZXN1bHQgPSB7bnVtYmVyQWZmZWN0ZWQ6IHVwZGF0ZUNvdW50fTtcblxuICAgICAgaWYgKGluc2VydGVkSWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXN1bHQuaW5zZXJ0ZWRJZCA9IGluc2VydGVkSWQ7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdCA9IHVwZGF0ZUNvdW50O1xuICAgIH1cblxuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgTWV0ZW9yLmRlZmVyKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBBIGNvbnZlbmllbmNlIHdyYXBwZXIgb24gdXBkYXRlLiBMb2NhbENvbGxlY3Rpb24udXBzZXJ0KHNlbCwgbW9kKSBpc1xuICAvLyBlcXVpdmFsZW50IHRvIExvY2FsQ29sbGVjdGlvbi51cGRhdGUoc2VsLCBtb2QsIHt1cHNlcnQ6IHRydWUsXG4gIC8vIF9yZXR1cm5PYmplY3Q6IHRydWV9KS5cbiAgdXBzZXJ0KHNlbGVjdG9yLCBtb2QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCFjYWxsYmFjayAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnVwZGF0ZShcbiAgICAgIHNlbGVjdG9yLFxuICAgICAgbW9kLFxuICAgICAgT2JqZWN0LmFzc2lnbih7fSwgb3B0aW9ucywge3Vwc2VydDogdHJ1ZSwgX3JldHVybk9iamVjdDogdHJ1ZX0pLFxuICAgICAgY2FsbGJhY2tcbiAgICApO1xuICB9XG5cbiAgLy8gSXRlcmF0ZXMgb3ZlciBhIHN1YnNldCBvZiBkb2N1bWVudHMgdGhhdCBjb3VsZCBtYXRjaCBzZWxlY3RvcjsgY2FsbHNcbiAgLy8gZm4oZG9jLCBpZCkgb24gZWFjaCBvZiB0aGVtLiAgU3BlY2lmaWNhbGx5LCBpZiBzZWxlY3RvciBzcGVjaWZpZXNcbiAgLy8gc3BlY2lmaWMgX2lkJ3MsIGl0IG9ubHkgbG9va3MgYXQgdGhvc2UuICBkb2MgaXMgKm5vdCogY2xvbmVkOiBpdCBpcyB0aGVcbiAgLy8gc2FtZSBvYmplY3QgdGhhdCBpcyBpbiBfZG9jcy5cbiAgX2VhY2hQb3NzaWJseU1hdGNoaW5nRG9jKHNlbGVjdG9yLCBmbikge1xuICAgIGNvbnN0IHNwZWNpZmljSWRzID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cbiAgICBpZiAoc3BlY2lmaWNJZHMpIHtcbiAgICAgIHNwZWNpZmljSWRzLnNvbWUoaWQgPT4ge1xuICAgICAgICBjb25zdCBkb2MgPSB0aGlzLl9kb2NzLmdldChpZCk7XG5cbiAgICAgICAgaWYgKGRvYykge1xuICAgICAgICAgIHJldHVybiBmbihkb2MsIGlkKSA9PT0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9kb2NzLmZvckVhY2goZm4pO1xuICAgIH1cbiAgfVxuXG4gIF9tb2RpZnlBbmROb3RpZnkoZG9jLCBtb2QsIHJlY29tcHV0ZVFpZHMsIGFycmF5SW5kaWNlcykge1xuICAgIGNvbnN0IG1hdGNoZWRfYmVmb3JlID0ge307XG5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgIGlmIChxdWVyeS5kaXJ0eSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChxdWVyeS5vcmRlcmVkKSB7XG4gICAgICAgIG1hdGNoZWRfYmVmb3JlW3FpZF0gPSBxdWVyeS5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpLnJlc3VsdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEJlY2F1c2Ugd2UgZG9uJ3Qgc3VwcG9ydCBza2lwIG9yIGxpbWl0ICh5ZXQpIGluIHVub3JkZXJlZCBxdWVyaWVzLCB3ZVxuICAgICAgICAvLyBjYW4ganVzdCBkbyBhIGRpcmVjdCBsb29rdXAuXG4gICAgICAgIG1hdGNoZWRfYmVmb3JlW3FpZF0gPSBxdWVyeS5yZXN1bHRzLmhhcyhkb2MuX2lkKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IG9sZF9kb2MgPSBFSlNPTi5jbG9uZShkb2MpO1xuXG4gICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkoZG9jLCBtb2QsIHthcnJheUluZGljZXN9KTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgYWZ0ZXJNYXRjaCA9IHF1ZXJ5Lm1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGRvYyk7XG4gICAgICBjb25zdCBhZnRlciA9IGFmdGVyTWF0Y2gucmVzdWx0O1xuICAgICAgY29uc3QgYmVmb3JlID0gbWF0Y2hlZF9iZWZvcmVbcWlkXTtcblxuICAgICAgaWYgKGFmdGVyICYmIHF1ZXJ5LmRpc3RhbmNlcyAmJiBhZnRlck1hdGNoLmRpc3RhbmNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcXVlcnkuZGlzdGFuY2VzLnNldChkb2MuX2lkLCBhZnRlck1hdGNoLmRpc3RhbmNlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHF1ZXJ5LmN1cnNvci5za2lwIHx8IHF1ZXJ5LmN1cnNvci5saW1pdCkge1xuICAgICAgICAvLyBXZSBuZWVkIHRvIHJlY29tcHV0ZSBhbnkgcXVlcnkgd2hlcmUgdGhlIGRvYyBtYXkgaGF2ZSBiZWVuIGluIHRoZVxuICAgICAgICAvLyBjdXJzb3IncyB3aW5kb3cgZWl0aGVyIGJlZm9yZSBvciBhZnRlciB0aGUgdXBkYXRlLiAoTm90ZSB0aGF0IGlmIHNraXBcbiAgICAgICAgLy8gb3IgbGltaXQgaXMgc2V0LCBcImJlZm9yZVwiIGFuZCBcImFmdGVyXCIgYmVpbmcgdHJ1ZSBkbyBub3QgbmVjZXNzYXJpbHlcbiAgICAgICAgLy8gbWVhbiB0aGF0IHRoZSBkb2N1bWVudCBpcyBpbiB0aGUgY3Vyc29yJ3Mgb3V0cHV0IGFmdGVyIHNraXAvbGltaXQgaXNcbiAgICAgICAgLy8gYXBwbGllZC4uLiBidXQgaWYgdGhleSBhcmUgZmFsc2UsIHRoZW4gdGhlIGRvY3VtZW50IGRlZmluaXRlbHkgaXMgTk9UXG4gICAgICAgIC8vIGluIHRoZSBvdXRwdXQuIFNvIGl0J3Mgc2FmZSB0byBza2lwIHJlY29tcHV0ZSBpZiBuZWl0aGVyIGJlZm9yZSBvclxuICAgICAgICAvLyBhZnRlciBhcmUgdHJ1ZS4pXG4gICAgICAgIGlmIChiZWZvcmUgfHwgYWZ0ZXIpIHtcbiAgICAgICAgICByZWNvbXB1dGVRaWRzW3FpZF0gPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGJlZm9yZSAmJiAhYWZ0ZXIpIHtcbiAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9yZW1vdmVGcm9tUmVzdWx0cyhxdWVyeSwgZG9jKTtcbiAgICAgIH0gZWxzZSBpZiAoIWJlZm9yZSAmJiBhZnRlcikge1xuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX2luc2VydEluUmVzdWx0cyhxdWVyeSwgZG9jKTtcbiAgICAgIH0gZWxzZSBpZiAoYmVmb3JlICYmIGFmdGVyKSB7XG4gICAgICAgIExvY2FsQ29sbGVjdGlvbi5fdXBkYXRlSW5SZXN1bHRzKHF1ZXJ5LCBkb2MsIG9sZF9kb2MpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gUmVjb21wdXRlcyB0aGUgcmVzdWx0cyBvZiBhIHF1ZXJ5IGFuZCBydW5zIG9ic2VydmUgY2FsbGJhY2tzIGZvciB0aGVcbiAgLy8gZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZSBwcmV2aW91cyByZXN1bHRzIGFuZCB0aGUgY3VycmVudCByZXN1bHRzICh1bmxlc3NcbiAgLy8gcGF1c2VkKS4gVXNlZCBmb3Igc2tpcC9saW1pdCBxdWVyaWVzLlxuICAvL1xuICAvLyBXaGVuIHRoaXMgaXMgdXNlZCBieSBpbnNlcnQgb3IgcmVtb3ZlLCBpdCBjYW4ganVzdCB1c2UgcXVlcnkucmVzdWx0cyBmb3JcbiAgLy8gdGhlIG9sZCByZXN1bHRzIChhbmQgdGhlcmUncyBubyBuZWVkIHRvIHBhc3MgaW4gb2xkUmVzdWx0cyksIGJlY2F1c2UgdGhlc2VcbiAgLy8gb3BlcmF0aW9ucyBkb24ndCBtdXRhdGUgdGhlIGRvY3VtZW50cyBpbiB0aGUgY29sbGVjdGlvbi4gVXBkYXRlIG5lZWRzIHRvXG4gIC8vIHBhc3MgaW4gYW4gb2xkUmVzdWx0cyB3aGljaCB3YXMgZGVlcC1jb3BpZWQgYmVmb3JlIHRoZSBtb2RpZmllciB3YXNcbiAgLy8gYXBwbGllZC5cbiAgLy9cbiAgLy8gb2xkUmVzdWx0cyBpcyBndWFyYW50ZWVkIHRvIGJlIGlnbm9yZWQgaWYgdGhlIHF1ZXJ5IGlzIG5vdCBwYXVzZWQuXG4gIF9yZWNvbXB1dGVSZXN1bHRzKHF1ZXJ5LCBvbGRSZXN1bHRzKSB7XG4gICAgaWYgKHRoaXMucGF1c2VkKSB7XG4gICAgICAvLyBUaGVyZSdzIG5vIHJlYXNvbiB0byByZWNvbXB1dGUgdGhlIHJlc3VsdHMgbm93IGFzIHdlJ3JlIHN0aWxsIHBhdXNlZC5cbiAgICAgIC8vIEJ5IGZsYWdnaW5nIHRoZSBxdWVyeSBhcyBcImRpcnR5XCIsIHRoZSByZWNvbXB1dGUgd2lsbCBiZSBwZXJmb3JtZWRcbiAgICAgIC8vIHdoZW4gcmVzdW1lT2JzZXJ2ZXJzIGlzIGNhbGxlZC5cbiAgICAgIHF1ZXJ5LmRpcnR5ID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMucGF1c2VkICYmICFvbGRSZXN1bHRzKSB7XG4gICAgICBvbGRSZXN1bHRzID0gcXVlcnkucmVzdWx0cztcbiAgICB9XG5cbiAgICBpZiAocXVlcnkuZGlzdGFuY2VzKSB7XG4gICAgICBxdWVyeS5kaXN0YW5jZXMuY2xlYXIoKTtcbiAgICB9XG5cbiAgICBxdWVyeS5yZXN1bHRzID0gcXVlcnkuY3Vyc29yLl9nZXRSYXdPYmplY3RzKHtcbiAgICAgIGRpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzLFxuICAgICAgb3JkZXJlZDogcXVlcnkub3JkZXJlZFxuICAgIH0pO1xuXG4gICAgaWYgKCF0aGlzLnBhdXNlZCkge1xuICAgICAgTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzKFxuICAgICAgICBxdWVyeS5vcmRlcmVkLFxuICAgICAgICBvbGRSZXN1bHRzLFxuICAgICAgICBxdWVyeS5yZXN1bHRzLFxuICAgICAgICBxdWVyeSxcbiAgICAgICAge3Byb2plY3Rpb25GbjogcXVlcnkucHJvamVjdGlvbkZufVxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBfc2F2ZU9yaWdpbmFsKGlkLCBkb2MpIHtcbiAgICAvLyBBcmUgd2UgZXZlbiB0cnlpbmcgdG8gc2F2ZSBvcmlnaW5hbHM/XG4gICAgaWYgKCF0aGlzLl9zYXZlZE9yaWdpbmFscykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEhhdmUgd2UgcHJldmlvdXNseSBtdXRhdGVkIHRoZSBvcmlnaW5hbCAoYW5kIHNvICdkb2MnIGlzIG5vdCBhY3R1YWxseVxuICAgIC8vIG9yaWdpbmFsKT8gIChOb3RlIHRoZSAnaGFzJyBjaGVjayByYXRoZXIgdGhhbiB0cnV0aDogd2Ugc3RvcmUgdW5kZWZpbmVkXG4gICAgLy8gaGVyZSBmb3IgaW5zZXJ0ZWQgZG9jcyEpXG4gICAgaWYgKHRoaXMuX3NhdmVkT3JpZ2luYWxzLmhhcyhpZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscy5zZXQoaWQsIEVKU09OLmNsb25lKGRvYykpO1xuICB9XG59XG5cbkxvY2FsQ29sbGVjdGlvbi5DdXJzb3IgPSBDdXJzb3I7XG5cbkxvY2FsQ29sbGVjdGlvbi5PYnNlcnZlSGFuZGxlID0gT2JzZXJ2ZUhhbmRsZTtcblxuLy8gWFhYIG1heWJlIG1vdmUgdGhlc2UgaW50byBhbm90aGVyIE9ic2VydmVIZWxwZXJzIHBhY2thZ2Ugb3Igc29tZXRoaW5nXG5cbi8vIF9DYWNoaW5nQ2hhbmdlT2JzZXJ2ZXIgaXMgYW4gb2JqZWN0IHdoaWNoIHJlY2VpdmVzIG9ic2VydmVDaGFuZ2VzIGNhbGxiYWNrc1xuLy8gYW5kIGtlZXBzIGEgY2FjaGUgb2YgdGhlIGN1cnJlbnQgY3Vyc29yIHN0YXRlIHVwIHRvIGRhdGUgaW4gdGhpcy5kb2NzLiBVc2Vyc1xuLy8gb2YgdGhpcyBjbGFzcyBzaG91bGQgcmVhZCB0aGUgZG9jcyBmaWVsZCBidXQgbm90IG1vZGlmeSBpdC4gWW91IHNob3VsZCBwYXNzXG4vLyB0aGUgXCJhcHBseUNoYW5nZVwiIGZpZWxkIGFzIHRoZSBjYWxsYmFja3MgdG8gdGhlIHVuZGVybHlpbmcgb2JzZXJ2ZUNoYW5nZXNcbi8vIGNhbGwuIE9wdGlvbmFsbHksIHlvdSBjYW4gc3BlY2lmeSB5b3VyIG93biBvYnNlcnZlQ2hhbmdlcyBjYWxsYmFja3Mgd2hpY2ggYXJlXG4vLyBpbnZva2VkIGltbWVkaWF0ZWx5IGJlZm9yZSB0aGUgZG9jcyBmaWVsZCBpcyB1cGRhdGVkOyB0aGlzIG9iamVjdCBpcyBtYWRlXG4vLyBhdmFpbGFibGUgYXMgYHRoaXNgIHRvIHRob3NlIGNhbGxiYWNrcy5cbkxvY2FsQ29sbGVjdGlvbi5fQ2FjaGluZ0NoYW5nZU9ic2VydmVyID0gY2xhc3MgX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciB7XG4gIGNvbnN0cnVjdG9yKG9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IG9yZGVyZWRGcm9tQ2FsbGJhY2tzID0gKFxuICAgICAgb3B0aW9ucy5jYWxsYmFja3MgJiZcbiAgICAgIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkKG9wdGlvbnMuY2FsbGJhY2tzKVxuICAgICk7XG5cbiAgICBpZiAoaGFzT3duLmNhbGwob3B0aW9ucywgJ29yZGVyZWQnKSkge1xuICAgICAgdGhpcy5vcmRlcmVkID0gb3B0aW9ucy5vcmRlcmVkO1xuXG4gICAgICBpZiAob3B0aW9ucy5jYWxsYmFja3MgJiYgb3B0aW9ucy5vcmRlcmVkICE9PSBvcmRlcmVkRnJvbUNhbGxiYWNrcykge1xuICAgICAgICB0aHJvdyBFcnJvcignb3JkZXJlZCBvcHRpb24gZG9lc25cXCd0IG1hdGNoIGNhbGxiYWNrcycpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAob3B0aW9ucy5jYWxsYmFja3MpIHtcbiAgICAgIHRoaXMub3JkZXJlZCA9IG9yZGVyZWRGcm9tQ2FsbGJhY2tzO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBFcnJvcignbXVzdCBwcm92aWRlIG9yZGVyZWQgb3IgY2FsbGJhY2tzJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2FsbGJhY2tzID0gb3B0aW9ucy5jYWxsYmFja3MgfHwge307XG5cbiAgICBpZiAodGhpcy5vcmRlcmVkKSB7XG4gICAgICB0aGlzLmRvY3MgPSBuZXcgT3JkZXJlZERpY3QoTW9uZ29JRC5pZFN0cmluZ2lmeSk7XG4gICAgICB0aGlzLmFwcGx5Q2hhbmdlID0ge1xuICAgICAgICBhZGRlZEJlZm9yZTogKGlkLCBmaWVsZHMsIGJlZm9yZSkgPT4ge1xuICAgICAgICAgIC8vIFRha2UgYSBzaGFsbG93IGNvcHkgc2luY2UgdGhlIHRvcC1sZXZlbCBwcm9wZXJ0aWVzIGNhbiBiZSBjaGFuZ2VkXG4gICAgICAgICAgY29uc3QgZG9jID0geyAuLi5maWVsZHMgfTtcblxuICAgICAgICAgIGRvYy5faWQgPSBpZDtcblxuICAgICAgICAgIGlmIChjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrcy5hZGRlZEJlZm9yZS5jYWxsKHRoaXMsIGlkLCBFSlNPTi5jbG9uZShmaWVsZHMpLCBiZWZvcmUpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFRoaXMgbGluZSB0cmlnZ2VycyBpZiB3ZSBwcm92aWRlIGFkZGVkIHdpdGggbW92ZWRCZWZvcmUuXG4gICAgICAgICAgaWYgKGNhbGxiYWNrcy5hZGRlZCkge1xuICAgICAgICAgICAgY2FsbGJhY2tzLmFkZGVkLmNhbGwodGhpcywgaWQsIEVKU09OLmNsb25lKGZpZWxkcykpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFhYWCBjb3VsZCBgYmVmb3JlYCBiZSBhIGZhbHN5IElEPyAgVGVjaG5pY2FsbHlcbiAgICAgICAgICAvLyBpZFN0cmluZ2lmeSBzZWVtcyB0byBhbGxvdyBmb3IgdGhlbSAtLSB0aG91Z2hcbiAgICAgICAgICAvLyBPcmRlcmVkRGljdCB3b24ndCBjYWxsIHN0cmluZ2lmeSBvbiBhIGZhbHN5IGFyZy5cbiAgICAgICAgICB0aGlzLmRvY3MucHV0QmVmb3JlKGlkLCBkb2MsIGJlZm9yZSB8fCBudWxsKTtcbiAgICAgICAgfSxcbiAgICAgICAgbW92ZWRCZWZvcmU6IChpZCwgYmVmb3JlKSA9PiB7XG4gICAgICAgICAgY29uc3QgZG9jID0gdGhpcy5kb2NzLmdldChpZCk7XG5cbiAgICAgICAgICBpZiAoY2FsbGJhY2tzLm1vdmVkQmVmb3JlKSB7XG4gICAgICAgICAgICBjYWxsYmFja3MubW92ZWRCZWZvcmUuY2FsbCh0aGlzLCBpZCwgYmVmb3JlKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB0aGlzLmRvY3MubW92ZUJlZm9yZShpZCwgYmVmb3JlIHx8IG51bGwpO1xuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5kb2NzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gICAgICB0aGlzLmFwcGx5Q2hhbmdlID0ge1xuICAgICAgICBhZGRlZDogKGlkLCBmaWVsZHMpID0+IHtcbiAgICAgICAgICAvLyBUYWtlIGEgc2hhbGxvdyBjb3B5IHNpbmNlIHRoZSB0b3AtbGV2ZWwgcHJvcGVydGllcyBjYW4gYmUgY2hhbmdlZFxuICAgICAgICAgIGNvbnN0IGRvYyA9IHsgLi4uZmllbGRzIH07XG5cbiAgICAgICAgICBpZiAoY2FsbGJhY2tzLmFkZGVkKSB7XG4gICAgICAgICAgICBjYWxsYmFja3MuYWRkZWQuY2FsbCh0aGlzLCBpZCwgRUpTT04uY2xvbmUoZmllbGRzKSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZG9jLl9pZCA9IGlkO1xuXG4gICAgICAgICAgdGhpcy5kb2NzLnNldChpZCwgIGRvYyk7XG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFRoZSBtZXRob2RzIGluIF9JZE1hcCBhbmQgT3JkZXJlZERpY3QgdXNlZCBieSB0aGVzZSBjYWxsYmFja3MgYXJlXG4gICAgLy8gaWRlbnRpY2FsLlxuICAgIHRoaXMuYXBwbHlDaGFuZ2UuY2hhbmdlZCA9IChpZCwgZmllbGRzKSA9PiB7XG4gICAgICBjb25zdCBkb2MgPSB0aGlzLmRvY3MuZ2V0KGlkKTtcblxuICAgICAgaWYgKCFkb2MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGlkIGZvciBjaGFuZ2VkOiAke2lkfWApO1xuICAgICAgfVxuXG4gICAgICBpZiAoY2FsbGJhY2tzLmNoYW5nZWQpIHtcbiAgICAgICAgY2FsbGJhY2tzLmNoYW5nZWQuY2FsbCh0aGlzLCBpZCwgRUpTT04uY2xvbmUoZmllbGRzKSk7XG4gICAgICB9XG5cbiAgICAgIERpZmZTZXF1ZW5jZS5hcHBseUNoYW5nZXMoZG9jLCBmaWVsZHMpO1xuICAgIH07XG5cbiAgICB0aGlzLmFwcGx5Q2hhbmdlLnJlbW92ZWQgPSBpZCA9PiB7XG4gICAgICBpZiAoY2FsbGJhY2tzLnJlbW92ZWQpIHtcbiAgICAgICAgY2FsbGJhY2tzLnJlbW92ZWQuY2FsbCh0aGlzLCBpZCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuZG9jcy5yZW1vdmUoaWQpO1xuICAgIH07XG4gIH1cbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fSWRNYXAgPSBjbGFzcyBfSWRNYXAgZXh0ZW5kcyBJZE1hcCB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKE1vbmdvSUQuaWRTdHJpbmdpZnksIE1vbmdvSUQuaWRQYXJzZSk7XG4gIH1cbn07XG5cbi8vIFdyYXAgYSB0cmFuc2Zvcm0gZnVuY3Rpb24gdG8gcmV0dXJuIG9iamVjdHMgdGhhdCBoYXZlIHRoZSBfaWQgZmllbGRcbi8vIG9mIHRoZSB1bnRyYW5zZm9ybWVkIGRvY3VtZW50LiBUaGlzIGVuc3VyZXMgdGhhdCBzdWJzeXN0ZW1zIHN1Y2ggYXNcbi8vIHRoZSBvYnNlcnZlLXNlcXVlbmNlIHBhY2thZ2UgdGhhdCBjYWxsIGBvYnNlcnZlYCBjYW4ga2VlcCB0cmFjayBvZlxuLy8gdGhlIGRvY3VtZW50cyBpZGVudGl0aWVzLlxuLy9cbi8vIC0gUmVxdWlyZSB0aGF0IGl0IHJldHVybnMgb2JqZWN0c1xuLy8gLSBJZiB0aGUgcmV0dXJuIHZhbHVlIGhhcyBhbiBfaWQgZmllbGQsIHZlcmlmeSB0aGF0IGl0IG1hdGNoZXMgdGhlXG4vLyAgIG9yaWdpbmFsIF9pZCBmaWVsZFxuLy8gLSBJZiB0aGUgcmV0dXJuIHZhbHVlIGRvZXNuJ3QgaGF2ZSBhbiBfaWQgZmllbGQsIGFkZCBpdCBiYWNrLlxuTG9jYWxDb2xsZWN0aW9uLndyYXBUcmFuc2Zvcm0gPSB0cmFuc2Zvcm0gPT4ge1xuICBpZiAoIXRyYW5zZm9ybSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gTm8gbmVlZCB0byBkb3VibHktd3JhcCB0cmFuc2Zvcm1zLlxuICBpZiAodHJhbnNmb3JtLl9fd3JhcHBlZFRyYW5zZm9ybV9fKSB7XG4gICAgcmV0dXJuIHRyYW5zZm9ybTtcbiAgfVxuXG4gIGNvbnN0IHdyYXBwZWQgPSBkb2MgPT4ge1xuICAgIGlmICghaGFzT3duLmNhbGwoZG9jLCAnX2lkJykpIHtcbiAgICAgIC8vIFhYWCBkbyB3ZSBldmVyIGhhdmUgYSB0cmFuc2Zvcm0gb24gdGhlIG9wbG9nJ3MgY29sbGVjdGlvbj8gYmVjYXVzZSB0aGF0XG4gICAgICAvLyBjb2xsZWN0aW9uIGhhcyBubyBfaWQuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NhbiBvbmx5IHRyYW5zZm9ybSBkb2N1bWVudHMgd2l0aCBfaWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGRvYy5faWQ7XG5cbiAgICAvLyBYWFggY29uc2lkZXIgbWFraW5nIHRyYWNrZXIgYSB3ZWFrIGRlcGVuZGVuY3kgYW5kIGNoZWNraW5nXG4gICAgLy8gUGFja2FnZS50cmFja2VyIGhlcmVcbiAgICBjb25zdCB0cmFuc2Zvcm1lZCA9IFRyYWNrZXIubm9ucmVhY3RpdmUoKCkgPT4gdHJhbnNmb3JtKGRvYykpO1xuXG4gICAgaWYgKCFMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QodHJhbnNmb3JtZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RyYW5zZm9ybSBtdXN0IHJldHVybiBvYmplY3QnKTtcbiAgICB9XG5cbiAgICBpZiAoaGFzT3duLmNhbGwodHJhbnNmb3JtZWQsICdfaWQnKSkge1xuICAgICAgaWYgKCFFSlNPTi5lcXVhbHModHJhbnNmb3JtZWQuX2lkLCBpZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0cmFuc2Zvcm1lZCBkb2N1bWVudCBjYW5cXCd0IGhhdmUgZGlmZmVyZW50IF9pZCcpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0cmFuc2Zvcm1lZC5faWQgPSBpZDtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJhbnNmb3JtZWQ7XG4gIH07XG5cbiAgd3JhcHBlZC5fX3dyYXBwZWRUcmFuc2Zvcm1fXyA9IHRydWU7XG5cbiAgcmV0dXJuIHdyYXBwZWQ7XG59O1xuXG4vLyBYWFggdGhlIHNvcnRlZC1xdWVyeSBsb2dpYyBiZWxvdyBpcyBsYXVnaGFibHkgaW5lZmZpY2llbnQuIHdlJ2xsXG4vLyBuZWVkIHRvIGNvbWUgdXAgd2l0aCBhIGJldHRlciBkYXRhc3RydWN0dXJlIGZvciB0aGlzLlxuLy9cbi8vIFhYWCB0aGUgbG9naWMgZm9yIG9ic2VydmluZyB3aXRoIGEgc2tpcCBvciBhIGxpbWl0IGlzIGV2ZW4gbW9yZVxuLy8gbGF1Z2hhYmx5IGluZWZmaWNpZW50LiB3ZSByZWNvbXB1dGUgdGhlIHdob2xlIHJlc3VsdHMgZXZlcnkgdGltZSFcblxuLy8gVGhpcyBiaW5hcnkgc2VhcmNoIHB1dHMgYSB2YWx1ZSBiZXR3ZWVuIGFueSBlcXVhbCB2YWx1ZXMsIGFuZCB0aGUgZmlyc3Rcbi8vIGxlc3NlciB2YWx1ZS5cbkxvY2FsQ29sbGVjdGlvbi5fYmluYXJ5U2VhcmNoID0gKGNtcCwgYXJyYXksIHZhbHVlKSA9PiB7XG4gIGxldCBmaXJzdCA9IDA7XG4gIGxldCByYW5nZSA9IGFycmF5Lmxlbmd0aDtcblxuICB3aGlsZSAocmFuZ2UgPiAwKSB7XG4gICAgY29uc3QgaGFsZlJhbmdlID0gTWF0aC5mbG9vcihyYW5nZSAvIDIpO1xuXG4gICAgaWYgKGNtcCh2YWx1ZSwgYXJyYXlbZmlyc3QgKyBoYWxmUmFuZ2VdKSA+PSAwKSB7XG4gICAgICBmaXJzdCArPSBoYWxmUmFuZ2UgKyAxO1xuICAgICAgcmFuZ2UgLT0gaGFsZlJhbmdlICsgMTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmFuZ2UgPSBoYWxmUmFuZ2U7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZpcnN0O1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9jaGVja1N1cHBvcnRlZFByb2plY3Rpb24gPSBmaWVsZHMgPT4ge1xuICBpZiAoZmllbGRzICE9PSBPYmplY3QoZmllbGRzKSB8fCBBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignZmllbGRzIG9wdGlvbiBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICB9XG5cbiAgT2JqZWN0LmtleXMoZmllbGRzKS5mb3JFYWNoKGtleVBhdGggPT4ge1xuICAgIGlmIChrZXlQYXRoLnNwbGl0KCcuJykuaW5jbHVkZXMoJyQnKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdNaW5pbW9uZ28gZG9lc25cXCd0IHN1cHBvcnQgJCBvcGVyYXRvciBpbiBwcm9qZWN0aW9ucyB5ZXQuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB2YWx1ZSA9IGZpZWxkc1trZXlQYXRoXTtcblxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICAgIFsnJGVsZW1NYXRjaCcsICckbWV0YScsICckc2xpY2UnXS5zb21lKGtleSA9PlxuICAgICAgICAgIGhhc093bi5jYWxsKHZhbHVlLCBrZXkpXG4gICAgICAgICkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnTWluaW1vbmdvIGRvZXNuXFwndCBzdXBwb3J0IG9wZXJhdG9ycyBpbiBwcm9qZWN0aW9ucyB5ZXQuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIVsxLCAwLCB0cnVlLCBmYWxzZV0uaW5jbHVkZXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ1Byb2plY3Rpb24gdmFsdWVzIHNob3VsZCBiZSBvbmUgb2YgMSwgMCwgdHJ1ZSwgb3IgZmFsc2UnXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG59O1xuXG4vLyBLbm93cyBob3cgdG8gY29tcGlsZSBhIGZpZWxkcyBwcm9qZWN0aW9uIHRvIGEgcHJlZGljYXRlIGZ1bmN0aW9uLlxuLy8gQHJldHVybnMgLSBGdW5jdGlvbjogYSBjbG9zdXJlIHRoYXQgZmlsdGVycyBvdXQgYW4gb2JqZWN0IGFjY29yZGluZyB0byB0aGVcbi8vICAgICAgICAgICAgZmllbGRzIHByb2plY3Rpb24gcnVsZXM6XG4vLyAgICAgICAgICAgIEBwYXJhbSBvYmogLSBPYmplY3Q6IE1vbmdvREItc3R5bGVkIGRvY3VtZW50XG4vLyAgICAgICAgICAgIEByZXR1cm5zIC0gT2JqZWN0OiBhIGRvY3VtZW50IHdpdGggdGhlIGZpZWxkcyBmaWx0ZXJlZCBvdXRcbi8vICAgICAgICAgICAgICAgICAgICAgICBhY2NvcmRpbmcgdG8gcHJvamVjdGlvbiBydWxlcy4gRG9lc24ndCByZXRhaW4gc3ViZmllbGRzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgb2YgcGFzc2VkIGFyZ3VtZW50LlxuTG9jYWxDb2xsZWN0aW9uLl9jb21waWxlUHJvamVjdGlvbiA9IGZpZWxkcyA9PiB7XG4gIExvY2FsQ29sbGVjdGlvbi5fY2hlY2tTdXBwb3J0ZWRQcm9qZWN0aW9uKGZpZWxkcyk7XG5cbiAgY29uc3QgX2lkUHJvamVjdGlvbiA9IGZpZWxkcy5faWQgPT09IHVuZGVmaW5lZCA/IHRydWUgOiBmaWVsZHMuX2lkO1xuICBjb25zdCBkZXRhaWxzID0gcHJvamVjdGlvbkRldGFpbHMoZmllbGRzKTtcblxuICAvLyByZXR1cm5zIHRyYW5zZm9ybWVkIGRvYyBhY2NvcmRpbmcgdG8gcnVsZVRyZWVcbiAgY29uc3QgdHJhbnNmb3JtID0gKGRvYywgcnVsZVRyZWUpID0+IHtcbiAgICAvLyBTcGVjaWFsIGNhc2UgZm9yIFwic2V0c1wiXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgICAgcmV0dXJuIGRvYy5tYXAoc3ViZG9jID0+IHRyYW5zZm9ybShzdWJkb2MsIHJ1bGVUcmVlKSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gZGV0YWlscy5pbmNsdWRpbmcgPyB7fSA6IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICBPYmplY3Qua2V5cyhydWxlVHJlZSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgaWYgKGRvYyA9PSBudWxsIHx8ICFoYXNPd24uY2FsbChkb2MsIGtleSkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBydWxlID0gcnVsZVRyZWVba2V5XTtcblxuICAgICAgaWYgKHJ1bGUgPT09IE9iamVjdChydWxlKSkge1xuICAgICAgICAvLyBGb3Igc3ViLW9iamVjdHMvc3Vic2V0cyB3ZSBicmFuY2hcbiAgICAgICAgaWYgKGRvY1trZXldID09PSBPYmplY3QoZG9jW2tleV0pKSB7XG4gICAgICAgICAgcmVzdWx0W2tleV0gPSB0cmFuc2Zvcm0oZG9jW2tleV0sIHJ1bGUpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGRldGFpbHMuaW5jbHVkaW5nKSB7XG4gICAgICAgIC8vIE90aGVyd2lzZSB3ZSBkb24ndCBldmVuIHRvdWNoIHRoaXMgc3ViZmllbGRcbiAgICAgICAgcmVzdWx0W2tleV0gPSBFSlNPTi5jbG9uZShkb2Nba2V5XSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWxldGUgcmVzdWx0W2tleV07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZG9jICE9IG51bGwgPyByZXN1bHQgOiBkb2M7XG4gIH07XG5cbiAgcmV0dXJuIGRvYyA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtKGRvYywgZGV0YWlscy50cmVlKTtcblxuICAgIGlmIChfaWRQcm9qZWN0aW9uICYmIGhhc093bi5jYWxsKGRvYywgJ19pZCcpKSB7XG4gICAgICByZXN1bHQuX2lkID0gZG9jLl9pZDtcbiAgICB9XG5cbiAgICBpZiAoIV9pZFByb2plY3Rpb24gJiYgaGFzT3duLmNhbGwocmVzdWx0LCAnX2lkJykpIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuX2lkO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG59O1xuXG4vLyBDYWxjdWxhdGVzIHRoZSBkb2N1bWVudCB0byBpbnNlcnQgaW4gY2FzZSB3ZSdyZSBkb2luZyBhbiB1cHNlcnQgYW5kIHRoZVxuLy8gc2VsZWN0b3IgZG9lcyBub3QgbWF0Y2ggYW55IGVsZW1lbnRzXG5Mb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50ID0gKHNlbGVjdG9yLCBtb2RpZmllcikgPT4ge1xuICBjb25zdCBzZWxlY3RvckRvY3VtZW50ID0gcG9wdWxhdGVEb2N1bWVudFdpdGhRdWVyeUZpZWxkcyhzZWxlY3Rvcik7XG4gIGNvbnN0IGlzTW9kaWZ5ID0gTG9jYWxDb2xsZWN0aW9uLl9pc01vZGlmaWNhdGlvbk1vZChtb2RpZmllcik7XG5cbiAgY29uc3QgbmV3RG9jID0ge307XG5cbiAgaWYgKHNlbGVjdG9yRG9jdW1lbnQuX2lkKSB7XG4gICAgbmV3RG9jLl9pZCA9IHNlbGVjdG9yRG9jdW1lbnQuX2lkO1xuICAgIGRlbGV0ZSBzZWxlY3RvckRvY3VtZW50Ll9pZDtcbiAgfVxuXG4gIC8vIFRoaXMgZG91YmxlIF9tb2RpZnkgY2FsbCBpcyBtYWRlIHRvIGhlbHAgd2l0aCBuZXN0ZWQgcHJvcGVydGllcyAoc2VlIGlzc3VlXG4gIC8vICM4NjMxKS4gV2UgZG8gdGhpcyBldmVuIGlmIGl0J3MgYSByZXBsYWNlbWVudCBmb3IgdmFsaWRhdGlvbiBwdXJwb3NlcyAoZS5nLlxuICAvLyBhbWJpZ3VvdXMgaWQncylcbiAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobmV3RG9jLCB7JHNldDogc2VsZWN0b3JEb2N1bWVudH0pO1xuICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShuZXdEb2MsIG1vZGlmaWVyLCB7aXNJbnNlcnQ6IHRydWV9KTtcblxuICBpZiAoaXNNb2RpZnkpIHtcbiAgICByZXR1cm4gbmV3RG9jO1xuICB9XG5cbiAgLy8gUmVwbGFjZW1lbnQgY2FuIHRha2UgX2lkIGZyb20gcXVlcnkgZG9jdW1lbnRcbiAgY29uc3QgcmVwbGFjZW1lbnQgPSBPYmplY3QuYXNzaWduKHt9LCBtb2RpZmllcik7XG4gIGlmIChuZXdEb2MuX2lkKSB7XG4gICAgcmVwbGFjZW1lbnQuX2lkID0gbmV3RG9jLl9pZDtcbiAgfVxuXG4gIHJldHVybiByZXBsYWNlbWVudDtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fZGlmZk9iamVjdHMgPSAobGVmdCwgcmlnaHQsIGNhbGxiYWNrcykgPT4ge1xuICByZXR1cm4gRGlmZlNlcXVlbmNlLmRpZmZPYmplY3RzKGxlZnQsIHJpZ2h0LCBjYWxsYmFja3MpO1xufTtcblxuLy8gb3JkZXJlZDogYm9vbC5cbi8vIG9sZF9yZXN1bHRzIGFuZCBuZXdfcmVzdWx0czogY29sbGVjdGlvbnMgb2YgZG9jdW1lbnRzLlxuLy8gICAgaWYgb3JkZXJlZCwgdGhleSBhcmUgYXJyYXlzLlxuLy8gICAgaWYgdW5vcmRlcmVkLCB0aGV5IGFyZSBJZE1hcHNcbkxvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5Q2hhbmdlcyA9IChvcmRlcmVkLCBvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucykgPT5cbiAgRGlmZlNlcXVlbmNlLmRpZmZRdWVyeUNoYW5nZXMob3JkZXJlZCwgb2xkUmVzdWx0cywgbmV3UmVzdWx0cywgb2JzZXJ2ZXIsIG9wdGlvbnMpXG47XG5cbkxvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5T3JkZXJlZENoYW5nZXMgPSAob2xkUmVzdWx0cywgbmV3UmVzdWx0cywgb2JzZXJ2ZXIsIG9wdGlvbnMpID0+XG4gIERpZmZTZXF1ZW5jZS5kaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyhvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucylcbjtcblxuTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzID0gKG9sZFJlc3VsdHMsIG5ld1Jlc3VsdHMsIG9ic2VydmVyLCBvcHRpb25zKSA9PlxuICBEaWZmU2VxdWVuY2UuZGlmZlF1ZXJ5VW5vcmRlcmVkQ2hhbmdlcyhvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucylcbjtcblxuTG9jYWxDb2xsZWN0aW9uLl9maW5kSW5PcmRlcmVkUmVzdWx0cyA9IChxdWVyeSwgZG9jKSA9PiB7XG4gIGlmICghcXVlcnkub3JkZXJlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcignQ2FuXFwndCBjYWxsIF9maW5kSW5PcmRlcmVkUmVzdWx0cyBvbiB1bm9yZGVyZWQgcXVlcnknKTtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcXVlcnkucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgIGlmIChxdWVyeS5yZXN1bHRzW2ldID09PSBkb2MpIHtcbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgfVxuXG4gIHRocm93IEVycm9yKCdvYmplY3QgbWlzc2luZyBmcm9tIHF1ZXJ5Jyk7XG59O1xuXG4vLyBJZiB0aGlzIGlzIGEgc2VsZWN0b3Igd2hpY2ggZXhwbGljaXRseSBjb25zdHJhaW5zIHRoZSBtYXRjaCBieSBJRCB0byBhIGZpbml0ZVxuLy8gbnVtYmVyIG9mIGRvY3VtZW50cywgcmV0dXJucyBhIGxpc3Qgb2YgdGhlaXIgSURzLiAgT3RoZXJ3aXNlIHJldHVybnNcbi8vIG51bGwuIE5vdGUgdGhhdCB0aGUgc2VsZWN0b3IgbWF5IGhhdmUgb3RoZXIgcmVzdHJpY3Rpb25zIHNvIGl0IG1heSBub3QgZXZlblxuLy8gbWF0Y2ggdGhvc2UgZG9jdW1lbnQhICBXZSBjYXJlIGFib3V0ICRpbiBhbmQgJGFuZCBzaW5jZSB0aG9zZSBhcmUgZ2VuZXJhdGVkXG4vLyBhY2Nlc3MtY29udHJvbGxlZCB1cGRhdGUgYW5kIHJlbW92ZS5cbkxvY2FsQ29sbGVjdGlvbi5faWRzTWF0Y2hlZEJ5U2VsZWN0b3IgPSBzZWxlY3RvciA9PiB7XG4gIC8vIElzIHRoZSBzZWxlY3RvciBqdXN0IGFuIElEP1xuICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKSB7XG4gICAgcmV0dXJuIFtzZWxlY3Rvcl07XG4gIH1cblxuICBpZiAoIXNlbGVjdG9yKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBEbyB3ZSBoYXZlIGFuIF9pZCBjbGF1c2U/XG4gIGlmIChoYXNPd24uY2FsbChzZWxlY3RvciwgJ19pZCcpKSB7XG4gICAgLy8gSXMgdGhlIF9pZCBjbGF1c2UganVzdCBhbiBJRD9cbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IuX2lkKSkge1xuICAgICAgcmV0dXJuIFtzZWxlY3Rvci5faWRdO1xuICAgIH1cblxuICAgIC8vIElzIHRoZSBfaWQgY2xhdXNlIHtfaWQ6IHskaW46IFtcInhcIiwgXCJ5XCIsIFwielwiXX19P1xuICAgIGlmIChzZWxlY3Rvci5faWRcbiAgICAgICAgJiYgQXJyYXkuaXNBcnJheShzZWxlY3Rvci5faWQuJGluKVxuICAgICAgICAmJiBzZWxlY3Rvci5faWQuJGluLmxlbmd0aFxuICAgICAgICAmJiBzZWxlY3Rvci5faWQuJGluLmV2ZXJ5KExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkKSkge1xuICAgICAgcmV0dXJuIHNlbGVjdG9yLl9pZC4kaW47XG4gICAgfVxuXG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBJZiB0aGlzIGlzIGEgdG9wLWxldmVsICRhbmQsIGFuZCBhbnkgb2YgdGhlIGNsYXVzZXMgY29uc3RyYWluIHRoZWlyXG4gIC8vIGRvY3VtZW50cywgdGhlbiB0aGUgd2hvbGUgc2VsZWN0b3IgaXMgY29uc3RyYWluZWQgYnkgYW55IG9uZSBjbGF1c2Unc1xuICAvLyBjb25zdHJhaW50LiAoV2VsbCwgYnkgdGhlaXIgaW50ZXJzZWN0aW9uLCBidXQgdGhhdCBzZWVtcyB1bmxpa2VseS4pXG4gIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdG9yLiRhbmQpKSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzZWxlY3Rvci4kYW5kLmxlbmd0aDsgKytpKSB7XG4gICAgICBjb25zdCBzdWJJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKHNlbGVjdG9yLiRhbmRbaV0pO1xuXG4gICAgICBpZiAoc3ViSWRzKSB7XG4gICAgICAgIHJldHVybiBzdWJJZHM7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2luc2VydEluUmVzdWx0cyA9IChxdWVyeSwgZG9jKSA9PiB7XG4gIGNvbnN0IGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgZGVsZXRlIGZpZWxkcy5faWQ7XG5cbiAgaWYgKHF1ZXJ5Lm9yZGVyZWQpIHtcbiAgICBpZiAoIXF1ZXJ5LnNvcnRlcikge1xuICAgICAgcXVlcnkuYWRkZWRCZWZvcmUoZG9jLl9pZCwgcXVlcnkucHJvamVjdGlvbkZuKGZpZWxkcyksIG51bGwpO1xuICAgICAgcXVlcnkucmVzdWx0cy5wdXNoKGRvYyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGkgPSBMb2NhbENvbGxlY3Rpb24uX2luc2VydEluU29ydGVkTGlzdChcbiAgICAgICAgcXVlcnkuc29ydGVyLmdldENvbXBhcmF0b3Ioe2Rpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzfSksXG4gICAgICAgIHF1ZXJ5LnJlc3VsdHMsXG4gICAgICAgIGRvY1xuICAgICAgKTtcblxuICAgICAgbGV0IG5leHQgPSBxdWVyeS5yZXN1bHRzW2kgKyAxXTtcbiAgICAgIGlmIChuZXh0KSB7XG4gICAgICAgIG5leHQgPSBuZXh0Ll9pZDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5leHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCBxdWVyeS5wcm9qZWN0aW9uRm4oZmllbGRzKSwgbmV4dCk7XG4gICAgfVxuXG4gICAgcXVlcnkuYWRkZWQoZG9jLl9pZCwgcXVlcnkucHJvamVjdGlvbkZuKGZpZWxkcykpO1xuICB9IGVsc2Uge1xuICAgIHF1ZXJ5LmFkZGVkKGRvYy5faWQsIHF1ZXJ5LnByb2plY3Rpb25GbihmaWVsZHMpKTtcbiAgICBxdWVyeS5yZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICB9XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2luc2VydEluU29ydGVkTGlzdCA9IChjbXAsIGFycmF5LCB2YWx1ZSkgPT4ge1xuICBpZiAoYXJyYXkubGVuZ3RoID09PSAwKSB7XG4gICAgYXJyYXkucHVzaCh2YWx1ZSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBjb25zdCBpID0gTG9jYWxDb2xsZWN0aW9uLl9iaW5hcnlTZWFyY2goY21wLCBhcnJheSwgdmFsdWUpO1xuXG4gIGFycmF5LnNwbGljZShpLCAwLCB2YWx1ZSk7XG5cbiAgcmV0dXJuIGk7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2lzTW9kaWZpY2F0aW9uTW9kID0gbW9kID0+IHtcbiAgbGV0IGlzTW9kaWZ5ID0gZmFsc2U7XG4gIGxldCBpc1JlcGxhY2UgPSBmYWxzZTtcblxuICBPYmplY3Qua2V5cyhtb2QpLmZvckVhY2goa2V5ID0+IHtcbiAgICBpZiAoa2V5LnN1YnN0cigwLCAxKSA9PT0gJyQnKSB7XG4gICAgICBpc01vZGlmeSA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlzUmVwbGFjZSA9IHRydWU7XG4gICAgfVxuICB9KTtcblxuICBpZiAoaXNNb2RpZnkgJiYgaXNSZXBsYWNlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgJ1VwZGF0ZSBwYXJhbWV0ZXIgY2Fubm90IGhhdmUgYm90aCBtb2RpZmllciBhbmQgbm9uLW1vZGlmaWVyIGZpZWxkcy4nXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBpc01vZGlmeTtcbn07XG5cbi8vIFhYWCBtYXliZSB0aGlzIHNob3VsZCBiZSBFSlNPTi5pc09iamVjdCwgdGhvdWdoIEVKU09OIGRvZXNuJ3Qga25vdyBhYm91dFxuLy8gUmVnRXhwXG4vLyBYWFggbm90ZSB0aGF0IF90eXBlKHVuZGVmaW5lZCkgPT09IDMhISEhXG5Mb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QgPSB4ID0+IHtcbiAgcmV0dXJuIHggJiYgTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKHgpID09PSAzO1xufTtcblxuLy8gWFhYIG5lZWQgYSBzdHJhdGVneSBmb3IgcGFzc2luZyB0aGUgYmluZGluZyBvZiAkIGludG8gdGhpc1xuLy8gZnVuY3Rpb24sIGZyb20gdGhlIGNvbXBpbGVkIHNlbGVjdG9yXG4vL1xuLy8gbWF5YmUganVzdCB7a2V5LnVwLnRvLmp1c3QuYmVmb3JlLmRvbGxhcnNpZ246IGFycmF5X2luZGV4fVxuLy9cbi8vIFhYWCBhdG9taWNpdHk6IGlmIG9uZSBtb2RpZmljYXRpb24gZmFpbHMsIGRvIHdlIHJvbGwgYmFjayB0aGUgd2hvbGVcbi8vIGNoYW5nZT9cbi8vXG4vLyBvcHRpb25zOlxuLy8gICAtIGlzSW5zZXJ0IGlzIHNldCB3aGVuIF9tb2RpZnkgaXMgYmVpbmcgY2FsbGVkIHRvIGNvbXB1dGUgdGhlIGRvY3VtZW50IHRvXG4vLyAgICAgaW5zZXJ0IGFzIHBhcnQgb2YgYW4gdXBzZXJ0IG9wZXJhdGlvbi4gV2UgdXNlIHRoaXMgcHJpbWFyaWx5IHRvIGZpZ3VyZVxuLy8gICAgIG91dCB3aGVuIHRvIHNldCB0aGUgZmllbGRzIGluICRzZXRPbkluc2VydCwgaWYgcHJlc2VudC5cbkxvY2FsQ29sbGVjdGlvbi5fbW9kaWZ5ID0gKGRvYywgbW9kaWZpZXIsIG9wdGlvbnMgPSB7fSkgPT4ge1xuICBpZiAoIUxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChtb2RpZmllcikpIHtcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignTW9kaWZpZXIgbXVzdCBiZSBhbiBvYmplY3QnKTtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB0aGUgY2FsbGVyIGNhbid0IG11dGF0ZSBvdXIgZGF0YSBzdHJ1Y3R1cmVzLlxuICBtb2RpZmllciA9IEVKU09OLmNsb25lKG1vZGlmaWVyKTtcblxuICBjb25zdCBpc01vZGlmaWVyID0gaXNPcGVyYXRvck9iamVjdChtb2RpZmllcik7XG4gIGNvbnN0IG5ld0RvYyA9IGlzTW9kaWZpZXIgPyBFSlNPTi5jbG9uZShkb2MpIDogbW9kaWZpZXI7XG5cbiAgaWYgKGlzTW9kaWZpZXIpIHtcbiAgICAvLyBhcHBseSBtb2RpZmllcnMgdG8gdGhlIGRvYy5cbiAgICBPYmplY3Qua2V5cyhtb2RpZmllcikuZm9yRWFjaChvcGVyYXRvciA9PiB7XG4gICAgICAvLyBUcmVhdCAkc2V0T25JbnNlcnQgYXMgJHNldCBpZiB0aGlzIGlzIGFuIGluc2VydC5cbiAgICAgIGNvbnN0IHNldE9uSW5zZXJ0ID0gb3B0aW9ucy5pc0luc2VydCAmJiBvcGVyYXRvciA9PT0gJyRzZXRPbkluc2VydCc7XG4gICAgICBjb25zdCBtb2RGdW5jID0gTU9ESUZJRVJTW3NldE9uSW5zZXJ0ID8gJyRzZXQnIDogb3BlcmF0b3JdO1xuICAgICAgY29uc3Qgb3BlcmFuZCA9IG1vZGlmaWVyW29wZXJhdG9yXTtcblxuICAgICAgaWYgKCFtb2RGdW5jKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKGBJbnZhbGlkIG1vZGlmaWVyIHNwZWNpZmllZCAke29wZXJhdG9yfWApO1xuICAgICAgfVxuXG4gICAgICBPYmplY3Qua2V5cyhvcGVyYW5kKS5mb3JFYWNoKGtleXBhdGggPT4ge1xuICAgICAgICBjb25zdCBhcmcgPSBvcGVyYW5kW2tleXBhdGhdO1xuXG4gICAgICAgIGlmIChrZXlwYXRoID09PSAnJykge1xuICAgICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdBbiBlbXB0eSB1cGRhdGUgcGF0aCBpcyBub3QgdmFsaWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBrZXlwYXJ0cyA9IGtleXBhdGguc3BsaXQoJy4nKTtcblxuICAgICAgICBpZiAoIWtleXBhcnRzLmV2ZXJ5KEJvb2xlYW4pKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICBgVGhlIHVwZGF0ZSBwYXRoICcke2tleXBhdGh9JyBjb250YWlucyBhbiBlbXB0eSBmaWVsZCBuYW1lLCBgICtcbiAgICAgICAgICAgICd3aGljaCBpcyBub3QgYWxsb3dlZC4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGZpbmRNb2RUYXJnZXQobmV3RG9jLCBrZXlwYXJ0cywge1xuICAgICAgICAgIGFycmF5SW5kaWNlczogb3B0aW9ucy5hcnJheUluZGljZXMsXG4gICAgICAgICAgZm9yYmlkQXJyYXk6IG9wZXJhdG9yID09PSAnJHJlbmFtZScsXG4gICAgICAgICAgbm9DcmVhdGU6IE5PX0NSRUFURV9NT0RJRklFUlNbb3BlcmF0b3JdXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG1vZEZ1bmModGFyZ2V0LCBrZXlwYXJ0cy5wb3AoKSwgYXJnLCBrZXlwYXRoLCBuZXdEb2MpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBpZiAoZG9jLl9pZCAmJiAhRUpTT04uZXF1YWxzKGRvYy5faWQsIG5ld0RvYy5faWQpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgYEFmdGVyIGFwcGx5aW5nIHRoZSB1cGRhdGUgdG8gdGhlIGRvY3VtZW50IHtfaWQ6IFwiJHtkb2MuX2lkfVwiLCAuLi59LGAgK1xuICAgICAgICAnIHRoZSAoaW1tdXRhYmxlKSBmaWVsZCBcXCdfaWRcXCcgd2FzIGZvdW5kIHRvIGhhdmUgYmVlbiBhbHRlcmVkIHRvICcgK1xuICAgICAgICBgX2lkOiBcIiR7bmV3RG9jLl9pZH1cImBcbiAgICAgICk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkb2MuX2lkICYmIG1vZGlmaWVyLl9pZCAmJiAhRUpTT04uZXF1YWxzKGRvYy5faWQsIG1vZGlmaWVyLl9pZCkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgVGhlIF9pZCBmaWVsZCBjYW5ub3QgYmUgY2hhbmdlZCBmcm9tIHtfaWQ6IFwiJHtkb2MuX2lkfVwifSB0byBgICtcbiAgICAgICAgYHtfaWQ6IFwiJHttb2RpZmllci5faWR9XCJ9YFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyByZXBsYWNlIHRoZSB3aG9sZSBkb2N1bWVudFxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhtb2RpZmllcik7XG4gIH1cblxuICAvLyBtb3ZlIG5ldyBkb2N1bWVudCBpbnRvIHBsYWNlLlxuICBPYmplY3Qua2V5cyhkb2MpLmZvckVhY2goa2V5ID0+IHtcbiAgICAvLyBOb3RlOiB0aGlzIHVzZWQgdG8gYmUgZm9yICh2YXIga2V5IGluIGRvYykgaG93ZXZlciwgdGhpcyBkb2VzIG5vdFxuICAgIC8vIHdvcmsgcmlnaHQgaW4gT3BlcmEuIERlbGV0aW5nIGZyb20gYSBkb2Mgd2hpbGUgaXRlcmF0aW5nIG92ZXIgaXRcbiAgICAvLyB3b3VsZCBzb21ldGltZXMgY2F1c2Ugb3BlcmEgdG8gc2tpcCBzb21lIGtleXMuXG4gICAgaWYgKGtleSAhPT0gJ19pZCcpIHtcbiAgICAgIGRlbGV0ZSBkb2Nba2V5XTtcbiAgICB9XG4gIH0pO1xuXG4gIE9iamVjdC5rZXlzKG5ld0RvYykuZm9yRWFjaChrZXkgPT4ge1xuICAgIGRvY1trZXldID0gbmV3RG9jW2tleV07XG4gIH0pO1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9vYnNlcnZlRnJvbU9ic2VydmVDaGFuZ2VzID0gKGN1cnNvciwgb2JzZXJ2ZUNhbGxiYWNrcykgPT4ge1xuICBjb25zdCB0cmFuc2Zvcm0gPSBjdXJzb3IuZ2V0VHJhbnNmb3JtKCkgfHwgKGRvYyA9PiBkb2MpO1xuICBsZXQgc3VwcHJlc3NlZCA9ICEhb2JzZXJ2ZUNhbGxiYWNrcy5fc3VwcHJlc3NfaW5pdGlhbDtcblxuICBsZXQgb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3M7XG4gIGlmIChMb2NhbENvbGxlY3Rpb24uX29ic2VydmVDYWxsYmFja3NBcmVPcmRlcmVkKG9ic2VydmVDYWxsYmFja3MpKSB7XG4gICAgLy8gVGhlIFwiX25vX2luZGljZXNcIiBvcHRpb24gc2V0cyBhbGwgaW5kZXggYXJndW1lbnRzIHRvIC0xIGFuZCBza2lwcyB0aGVcbiAgICAvLyBsaW5lYXIgc2NhbnMgcmVxdWlyZWQgdG8gZ2VuZXJhdGUgdGhlbS4gIFRoaXMgbGV0cyBvYnNlcnZlcnMgdGhhdCBkb24ndFxuICAgIC8vIG5lZWQgYWJzb2x1dGUgaW5kaWNlcyBiZW5lZml0IGZyb20gdGhlIG90aGVyIGZlYXR1cmVzIG9mIHRoaXMgQVBJIC0tXG4gICAgLy8gcmVsYXRpdmUgb3JkZXIsIHRyYW5zZm9ybXMsIGFuZCBhcHBseUNoYW5nZXMgLS0gd2l0aG91dCB0aGUgc3BlZWQgaGl0LlxuICAgIGNvbnN0IGluZGljZXMgPSAhb2JzZXJ2ZUNhbGxiYWNrcy5fbm9faW5kaWNlcztcblxuICAgIG9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzID0ge1xuICAgICAgYWRkZWRCZWZvcmUoaWQsIGZpZWxkcywgYmVmb3JlKSB7XG4gICAgICAgIGlmIChzdXBwcmVzc2VkIHx8ICEob2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0IHx8IG9ic2VydmVDYWxsYmFja3MuYWRkZWQpKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZG9jID0gdHJhbnNmb3JtKE9iamVjdC5hc3NpZ24oZmllbGRzLCB7X2lkOiBpZH0pKTtcblxuICAgICAgICBpZiAob2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0KSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0KFxuICAgICAgICAgICAgZG9jLFxuICAgICAgICAgICAgaW5kaWNlc1xuICAgICAgICAgICAgICA/IGJlZm9yZVxuICAgICAgICAgICAgICAgID8gdGhpcy5kb2NzLmluZGV4T2YoYmVmb3JlKVxuICAgICAgICAgICAgICAgIDogdGhpcy5kb2NzLnNpemUoKVxuICAgICAgICAgICAgICA6IC0xLFxuICAgICAgICAgICAgYmVmb3JlXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkKGRvYyk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjaGFuZ2VkKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgaWYgKCEob2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkQXQgfHwgb2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkKSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkb2MgPSBFSlNPTi5jbG9uZSh0aGlzLmRvY3MuZ2V0KGlkKSk7XG4gICAgICAgIGlmICghZG9jKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGlkIGZvciBjaGFuZ2VkOiAke2lkfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgb2xkRG9jID0gdHJhbnNmb3JtKEVKU09OLmNsb25lKGRvYykpO1xuXG4gICAgICAgIERpZmZTZXF1ZW5jZS5hcHBseUNoYW5nZXMoZG9jLCBmaWVsZHMpO1xuXG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWRBdCkge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZEF0KFxuICAgICAgICAgICAgdHJhbnNmb3JtKGRvYyksXG4gICAgICAgICAgICBvbGREb2MsXG4gICAgICAgICAgICBpbmRpY2VzID8gdGhpcy5kb2NzLmluZGV4T2YoaWQpIDogLTFcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZCh0cmFuc2Zvcm0oZG9jKSwgb2xkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIG1vdmVkQmVmb3JlKGlkLCBiZWZvcmUpIHtcbiAgICAgICAgaWYgKCFvYnNlcnZlQ2FsbGJhY2tzLm1vdmVkVG8pIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmcm9tID0gaW5kaWNlcyA/IHRoaXMuZG9jcy5pbmRleE9mKGlkKSA6IC0xO1xuICAgICAgICBsZXQgdG8gPSBpbmRpY2VzXG4gICAgICAgICAgPyBiZWZvcmVcbiAgICAgICAgICAgID8gdGhpcy5kb2NzLmluZGV4T2YoYmVmb3JlKVxuICAgICAgICAgICAgOiB0aGlzLmRvY3Muc2l6ZSgpXG4gICAgICAgICAgOiAtMTtcblxuICAgICAgICAvLyBXaGVuIG5vdCBtb3ZpbmcgYmFja3dhcmRzLCBhZGp1c3QgZm9yIHRoZSBmYWN0IHRoYXQgcmVtb3ZpbmcgdGhlXG4gICAgICAgIC8vIGRvY3VtZW50IHNsaWRlcyBldmVyeXRoaW5nIGJhY2sgb25lIHNsb3QuXG4gICAgICAgIGlmICh0byA+IGZyb20pIHtcbiAgICAgICAgICAtLXRvO1xuICAgICAgICB9XG5cbiAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5tb3ZlZFRvKFxuICAgICAgICAgIHRyYW5zZm9ybShFSlNPTi5jbG9uZSh0aGlzLmRvY3MuZ2V0KGlkKSkpLFxuICAgICAgICAgIGZyb20sXG4gICAgICAgICAgdG8sXG4gICAgICAgICAgYmVmb3JlIHx8IG51bGxcbiAgICAgICAgKTtcbiAgICAgIH0sXG4gICAgICByZW1vdmVkKGlkKSB7XG4gICAgICAgIGlmICghKG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZEF0IHx8IG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZCkpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyB0ZWNobmljYWxseSBtYXliZSB0aGVyZSBzaG91bGQgYmUgYW4gRUpTT04uY2xvbmUgaGVyZSwgYnV0IGl0J3MgYWJvdXRcbiAgICAgICAgLy8gdG8gYmUgcmVtb3ZlZCBmcm9tIHRoaXMuZG9jcyFcbiAgICAgICAgY29uc3QgZG9jID0gdHJhbnNmb3JtKHRoaXMuZG9jcy5nZXQoaWQpKTtcblxuICAgICAgICBpZiAob2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkQXQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWRBdChkb2MsIGluZGljZXMgPyB0aGlzLmRvY3MuaW5kZXhPZihpZCkgOiAtMSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkKGRvYyk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfTtcbiAgfSBlbHNlIHtcbiAgICBvYnNlcnZlQ2hhbmdlc0NhbGxiYWNrcyA9IHtcbiAgICAgIGFkZGVkKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgaWYgKCFzdXBwcmVzc2VkICYmIG9ic2VydmVDYWxsYmFja3MuYWRkZWQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkKHRyYW5zZm9ybShPYmplY3QuYXNzaWduKGZpZWxkcywge19pZDogaWR9KSkpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgY2hhbmdlZChpZCwgZmllbGRzKSB7XG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWQpIHtcbiAgICAgICAgICBjb25zdCBvbGREb2MgPSB0aGlzLmRvY3MuZ2V0KGlkKTtcbiAgICAgICAgICBjb25zdCBkb2MgPSBFSlNPTi5jbG9uZShvbGREb2MpO1xuXG4gICAgICAgICAgRGlmZlNlcXVlbmNlLmFwcGx5Q2hhbmdlcyhkb2MsIGZpZWxkcyk7XG5cbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWQoXG4gICAgICAgICAgICB0cmFuc2Zvcm0oZG9jKSxcbiAgICAgICAgICAgIHRyYW5zZm9ybShFSlNPTi5jbG9uZShvbGREb2MpKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICByZW1vdmVkKGlkKSB7XG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWQodHJhbnNmb3JtKHRoaXMuZG9jcy5nZXQoaWQpKSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZU9ic2VydmVyID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fQ2FjaGluZ0NoYW5nZU9ic2VydmVyKHtcbiAgICBjYWxsYmFja3M6IG9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzXG4gIH0pO1xuXG4gIC8vIENhY2hpbmdDaGFuZ2VPYnNlcnZlciBjbG9uZXMgYWxsIHJlY2VpdmVkIGlucHV0IG9uIGl0cyBjYWxsYmFja3NcbiAgLy8gU28gd2UgY2FuIG1hcmsgaXQgYXMgc2FmZSB0byByZWR1Y2UgdGhlIGVqc29uIGNsb25lcy5cbiAgLy8gVGhpcyBpcyB0ZXN0ZWQgYnkgdGhlIGBtb25nby1saXZlZGF0YSAtIChleHRlbmRlZCkgc2NyaWJibGluZ2AgdGVzdHNcbiAgY2hhbmdlT2JzZXJ2ZXIuYXBwbHlDaGFuZ2UuX2Zyb21PYnNlcnZlID0gdHJ1ZTtcbiAgY29uc3QgaGFuZGxlID0gY3Vyc29yLm9ic2VydmVDaGFuZ2VzKGNoYW5nZU9ic2VydmVyLmFwcGx5Q2hhbmdlLFxuICAgIHsgbm9uTXV0YXRpbmdDYWxsYmFja3M6IHRydWUgfSk7XG5cbiAgc3VwcHJlc3NlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBoYW5kbGU7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX29ic2VydmVDYWxsYmFja3NBcmVPcmRlcmVkID0gY2FsbGJhY2tzID0+IHtcbiAgaWYgKGNhbGxiYWNrcy5hZGRlZCAmJiBjYWxsYmFja3MuYWRkZWRBdCkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgYWRkZWQoKSBhbmQgYWRkZWRBdCgpJyk7XG4gIH1cblxuICBpZiAoY2FsbGJhY2tzLmNoYW5nZWQgJiYgY2FsbGJhY2tzLmNoYW5nZWRBdCkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgY2hhbmdlZCgpIGFuZCBjaGFuZ2VkQXQoKScpO1xuICB9XG5cbiAgaWYgKGNhbGxiYWNrcy5yZW1vdmVkICYmIGNhbGxiYWNrcy5yZW1vdmVkQXQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1BsZWFzZSBzcGVjaWZ5IG9ubHkgb25lIG9mIHJlbW92ZWQoKSBhbmQgcmVtb3ZlZEF0KCknKTtcbiAgfVxuXG4gIHJldHVybiAhIShcbiAgICBjYWxsYmFja3MuYWRkZWRBdCB8fFxuICAgIGNhbGxiYWNrcy5jaGFuZ2VkQXQgfHxcbiAgICBjYWxsYmFja3MubW92ZWRUbyB8fFxuICAgIGNhbGxiYWNrcy5yZW1vdmVkQXRcbiAgKTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkID0gY2FsbGJhY2tzID0+IHtcbiAgaWYgKGNhbGxiYWNrcy5hZGRlZCAmJiBjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1BsZWFzZSBzcGVjaWZ5IG9ubHkgb25lIG9mIGFkZGVkKCkgYW5kIGFkZGVkQmVmb3JlKCknKTtcbiAgfVxuXG4gIHJldHVybiAhIShjYWxsYmFja3MuYWRkZWRCZWZvcmUgfHwgY2FsbGJhY2tzLm1vdmVkQmVmb3JlKTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fcmVtb3ZlRnJvbVJlc3VsdHMgPSAocXVlcnksIGRvYykgPT4ge1xuICBpZiAocXVlcnkub3JkZXJlZCkge1xuICAgIGNvbnN0IGkgPSBMb2NhbENvbGxlY3Rpb24uX2ZpbmRJbk9yZGVyZWRSZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuXG4gICAgcXVlcnkucmVtb3ZlZChkb2MuX2lkKTtcbiAgICBxdWVyeS5yZXN1bHRzLnNwbGljZShpLCAxKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpZCA9IGRvYy5faWQ7ICAvLyBpbiBjYXNlIGNhbGxiYWNrIG11dGF0ZXMgZG9jXG5cbiAgICBxdWVyeS5yZW1vdmVkKGRvYy5faWQpO1xuICAgIHF1ZXJ5LnJlc3VsdHMucmVtb3ZlKGlkKTtcbiAgfVxufTtcblxuLy8gSXMgdGhpcyBzZWxlY3RvciBqdXN0IHNob3J0aGFuZCBmb3IgbG9va3VwIGJ5IF9pZD9cbkxvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkID0gc2VsZWN0b3IgPT5cbiAgdHlwZW9mIHNlbGVjdG9yID09PSAnbnVtYmVyJyB8fFxuICB0eXBlb2Ygc2VsZWN0b3IgPT09ICdzdHJpbmcnIHx8XG4gIHNlbGVjdG9yIGluc3RhbmNlb2YgTW9uZ29JRC5PYmplY3RJRFxuO1xuXG4vLyBJcyB0aGUgc2VsZWN0b3IganVzdCBsb29rdXAgYnkgX2lkIChzaG9ydGhhbmQgb3Igbm90KT9cbkxvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkUGVyaGFwc0FzT2JqZWN0ID0gc2VsZWN0b3IgPT5cbiAgTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpIHx8XG4gIExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkKHNlbGVjdG9yICYmIHNlbGVjdG9yLl9pZCkgJiZcbiAgT2JqZWN0LmtleXMoc2VsZWN0b3IpLmxlbmd0aCA9PT0gMVxuO1xuXG5Mb2NhbENvbGxlY3Rpb24uX3VwZGF0ZUluUmVzdWx0cyA9IChxdWVyeSwgZG9jLCBvbGRfZG9jKSA9PiB7XG4gIGlmICghRUpTT04uZXF1YWxzKGRvYy5faWQsIG9sZF9kb2MuX2lkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignQ2FuXFwndCBjaGFuZ2UgYSBkb2NcXCdzIF9pZCB3aGlsZSB1cGRhdGluZycpO1xuICB9XG5cbiAgY29uc3QgcHJvamVjdGlvbkZuID0gcXVlcnkucHJvamVjdGlvbkZuO1xuICBjb25zdCBjaGFuZ2VkRmllbGRzID0gRGlmZlNlcXVlbmNlLm1ha2VDaGFuZ2VkRmllbGRzKFxuICAgIHByb2plY3Rpb25Gbihkb2MpLFxuICAgIHByb2plY3Rpb25GbihvbGRfZG9jKVxuICApO1xuXG4gIGlmICghcXVlcnkub3JkZXJlZCkge1xuICAgIGlmIChPYmplY3Qua2V5cyhjaGFuZ2VkRmllbGRzKS5sZW5ndGgpIHtcbiAgICAgIHF1ZXJ5LmNoYW5nZWQoZG9jLl9pZCwgY2hhbmdlZEZpZWxkcyk7XG4gICAgICBxdWVyeS5yZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICAgIH1cblxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG9sZF9pZHggPSBMb2NhbENvbGxlY3Rpb24uX2ZpbmRJbk9yZGVyZWRSZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuXG4gIGlmIChPYmplY3Qua2V5cyhjaGFuZ2VkRmllbGRzKS5sZW5ndGgpIHtcbiAgICBxdWVyeS5jaGFuZ2VkKGRvYy5faWQsIGNoYW5nZWRGaWVsZHMpO1xuICB9XG5cbiAgaWYgKCFxdWVyeS5zb3J0ZXIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBqdXN0IHRha2UgaXQgb3V0IGFuZCBwdXQgaXQgYmFjayBpbiBhZ2FpbiwgYW5kIHNlZSBpZiB0aGUgaW5kZXggY2hhbmdlc1xuICBxdWVyeS5yZXN1bHRzLnNwbGljZShvbGRfaWR4LCAxKTtcblxuICBjb25zdCBuZXdfaWR4ID0gTG9jYWxDb2xsZWN0aW9uLl9pbnNlcnRJblNvcnRlZExpc3QoXG4gICAgcXVlcnkuc29ydGVyLmdldENvbXBhcmF0b3Ioe2Rpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzfSksXG4gICAgcXVlcnkucmVzdWx0cyxcbiAgICBkb2NcbiAgKTtcblxuICBpZiAob2xkX2lkeCAhPT0gbmV3X2lkeCkge1xuICAgIGxldCBuZXh0ID0gcXVlcnkucmVzdWx0c1tuZXdfaWR4ICsgMV07XG4gICAgaWYgKG5leHQpIHtcbiAgICAgIG5leHQgPSBuZXh0Ll9pZDtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV4dCA9IG51bGw7XG4gICAgfVxuXG4gICAgcXVlcnkubW92ZWRCZWZvcmUgJiYgcXVlcnkubW92ZWRCZWZvcmUoZG9jLl9pZCwgbmV4dCk7XG4gIH1cbn07XG5cbmNvbnN0IE1PRElGSUVSUyA9IHtcbiAgJGN1cnJlbnREYXRlKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBoYXNPd24uY2FsbChhcmcsICckdHlwZScpKSB7XG4gICAgICBpZiAoYXJnLiR0eXBlICE9PSAnZGF0ZScpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ01pbmltb25nbyBkb2VzIGN1cnJlbnRseSBvbmx5IHN1cHBvcnQgdGhlIGRhdGUgdHlwZSBpbiAnICtcbiAgICAgICAgICAnJGN1cnJlbnREYXRlIG1vZGlmaWVycycsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoYXJnICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignSW52YWxpZCAkY3VycmVudERhdGUgbW9kaWZpZXInLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICB0YXJnZXRbZmllbGRdID0gbmV3IERhdGUoKTtcbiAgfSxcbiAgJGluYyh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkaW5jIGFsbG93ZWQgZm9yIG51bWJlcnMgb25seScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmIChmaWVsZCBpbiB0YXJnZXQpIHtcbiAgICAgIGlmICh0eXBlb2YgdGFyZ2V0W2ZpZWxkXSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ0Nhbm5vdCBhcHBseSAkaW5jIG1vZGlmaWVyIHRvIG5vbi1udW1iZXInLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgdGFyZ2V0W2ZpZWxkXSArPSBhcmc7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gICAgfVxuICB9LFxuICAkbWluKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ01vZGlmaWVyICRtaW4gYWxsb3dlZCBmb3IgbnVtYmVycyBvbmx5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgaWYgKHR5cGVvZiB0YXJnZXRbZmllbGRdICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnQ2Fubm90IGFwcGx5ICRtaW4gbW9kaWZpZXIgdG8gbm9uLW51bWJlcicsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAodGFyZ2V0W2ZpZWxkXSA+IGFyZykge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgIH1cbiAgfSxcbiAgJG1heCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkbWF4IGFsbG93ZWQgZm9yIG51bWJlcnMgb25seScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmIChmaWVsZCBpbiB0YXJnZXQpIHtcbiAgICAgIGlmICh0eXBlb2YgdGFyZ2V0W2ZpZWxkXSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ0Nhbm5vdCBhcHBseSAkbWF4IG1vZGlmaWVyIHRvIG5vbi1udW1iZXInLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRhcmdldFtmaWVsZF0gPCBhcmcpIHtcbiAgICAgICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgICB9XG4gIH0sXG4gICRtdWwodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHR5cGVvZiBhcmcgIT09ICdudW1iZXInKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignTW9kaWZpZXIgJG11bCBhbGxvd2VkIGZvciBudW1iZXJzIG9ubHknLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGQgaW4gdGFyZ2V0KSB7XG4gICAgICBpZiAodHlwZW9mIHRhcmdldFtmaWVsZF0gIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgICdDYW5ub3QgYXBwbHkgJG11bCBtb2RpZmllciB0byBub24tbnVtYmVyJyxcbiAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHRhcmdldFtmaWVsZF0gKj0gYXJnO1xuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gMDtcbiAgICB9XG4gIH0sXG4gICRyZW5hbWUodGFyZ2V0LCBmaWVsZCwgYXJnLCBrZXlwYXRoLCBkb2MpIHtcbiAgICAvLyBubyBpZGVhIHdoeSBtb25nbyBoYXMgdGhpcyByZXN0cmljdGlvbi4uXG4gICAgaWYgKGtleXBhdGggPT09IGFyZykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgc291cmNlIG11c3QgZGlmZmVyIGZyb20gdGFyZ2V0Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgc291cmNlIGZpZWxkIGludmFsaWQnLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckcmVuYW1lIHRhcmdldCBtdXN0IGJlIGEgc3RyaW5nJywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGFyZy5pbmNsdWRlcygnXFwwJykpIHtcbiAgICAgIC8vIE51bGwgYnl0ZXMgYXJlIG5vdCBhbGxvd2VkIGluIE1vbmdvIGZpZWxkIG5hbWVzXG4gICAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9saW1pdHMvI1Jlc3RyaWN0aW9ucy1vbi1GaWVsZC1OYW1lc1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdUaGUgXFwndG9cXCcgZmllbGQgZm9yICRyZW5hbWUgY2Fubm90IGNvbnRhaW4gYW4gZW1iZWRkZWQgbnVsbCBieXRlJyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGFyZ2V0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvYmplY3QgPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgZGVsZXRlIHRhcmdldFtmaWVsZF07XG5cbiAgICBjb25zdCBrZXlwYXJ0cyA9IGFyZy5zcGxpdCgnLicpO1xuICAgIGNvbnN0IHRhcmdldDIgPSBmaW5kTW9kVGFyZ2V0KGRvYywga2V5cGFydHMsIHtmb3JiaWRBcnJheTogdHJ1ZX0pO1xuXG4gICAgaWYgKHRhcmdldDIgPT09IG51bGwpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckcmVuYW1lIHRhcmdldCBmaWVsZCBpbnZhbGlkJywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgdGFyZ2V0MltrZXlwYXJ0cy5wb3AoKV0gPSBvYmplY3Q7XG4gIH0sXG4gICRzZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCAhPT0gT2JqZWN0KHRhcmdldCkpIHsgLy8gbm90IGFuIGFycmF5IG9yIGFuIG9iamVjdFxuICAgICAgY29uc3QgZXJyb3IgPSBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBzZXQgcHJvcGVydHkgb24gbm9uLW9iamVjdCBmaWVsZCcsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgICBlcnJvci5zZXRQcm9wZXJ0eUVycm9yID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGlmICh0YXJnZXQgPT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gTWluaW1vbmdvRXJyb3IoJ0Nhbm5vdCBzZXQgcHJvcGVydHkgb24gbnVsbCcsIHtmaWVsZH0pO1xuICAgICAgZXJyb3Iuc2V0UHJvcGVydHlFcnJvciA9IHRydWU7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG5cbiAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoYXJnKTtcblxuICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gIH0sXG4gICRzZXRPbkluc2VydCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICAvLyBjb252ZXJ0ZWQgdG8gYCRzZXRgIGluIGBfbW9kaWZ5YFxuICB9LFxuICAkdW5zZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodGFyZ2V0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgICAgIHRhcmdldFtmaWVsZF0gPSBudWxsO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWxldGUgdGFyZ2V0W2ZpZWxkXTtcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gICRwdXNoKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXRbZmllbGRdID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBbXTtcbiAgICB9XG5cbiAgICBpZiAoISh0YXJnZXRbZmllbGRdIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignQ2Fubm90IGFwcGx5ICRwdXNoIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmICghKGFyZyAmJiBhcmcuJGVhY2gpKSB7XG4gICAgICAvLyBTaW1wbGUgbW9kZTogbm90ICRlYWNoXG4gICAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoYXJnKTtcblxuICAgICAgdGFyZ2V0W2ZpZWxkXS5wdXNoKGFyZyk7XG5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBGYW5jeSBtb2RlOiAkZWFjaCAoYW5kIG1heWJlICRzbGljZSBhbmQgJHNvcnQgYW5kICRwb3NpdGlvbilcbiAgICBjb25zdCB0b1B1c2ggPSBhcmcuJGVhY2g7XG4gICAgaWYgKCEodG9QdXNoIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJGVhY2ggbXVzdCBiZSBhbiBhcnJheScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyh0b1B1c2gpO1xuXG4gICAgLy8gUGFyc2UgJHBvc2l0aW9uXG4gICAgbGV0IHBvc2l0aW9uID0gdW5kZWZpbmVkO1xuICAgIGlmICgnJHBvc2l0aW9uJyBpbiBhcmcpIHtcbiAgICAgIGlmICh0eXBlb2YgYXJnLiRwb3NpdGlvbiAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRwb3NpdGlvbiBtdXN0IGJlIGEgbnVtZXJpYyB2YWx1ZScsIHtmaWVsZH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggc2hvdWxkIGNoZWNrIHRvIG1ha2Ugc3VyZSBpbnRlZ2VyXG4gICAgICBpZiAoYXJnLiRwb3NpdGlvbiA8IDApIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJyRwb3NpdGlvbiBpbiAkcHVzaCBtdXN0IGJlIHplcm8gb3IgcG9zaXRpdmUnLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcG9zaXRpb24gPSBhcmcuJHBvc2l0aW9uO1xuICAgIH1cblxuICAgIC8vIFBhcnNlICRzbGljZS5cbiAgICBsZXQgc2xpY2UgPSB1bmRlZmluZWQ7XG4gICAgaWYgKCckc2xpY2UnIGluIGFyZykge1xuICAgICAgaWYgKHR5cGVvZiBhcmcuJHNsaWNlICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJHNsaWNlIG11c3QgYmUgYSBudW1lcmljIHZhbHVlJywge2ZpZWxkfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFhYWCBzaG91bGQgY2hlY2sgdG8gbWFrZSBzdXJlIGludGVnZXJcbiAgICAgIHNsaWNlID0gYXJnLiRzbGljZTtcbiAgICB9XG5cbiAgICAvLyBQYXJzZSAkc29ydC5cbiAgICBsZXQgc29ydEZ1bmN0aW9uID0gdW5kZWZpbmVkO1xuICAgIGlmIChhcmcuJHNvcnQpIHtcbiAgICAgIGlmIChzbGljZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckc29ydCByZXF1aXJlcyAkc2xpY2UgdG8gYmUgcHJlc2VudCcsIHtmaWVsZH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggdGhpcyBhbGxvd3MgdXMgdG8gdXNlIGEgJHNvcnQgd2hvc2UgdmFsdWUgaXMgYW4gYXJyYXksIGJ1dCB0aGF0J3NcbiAgICAgIC8vIGFjdHVhbGx5IGFuIGV4dGVuc2lvbiBvZiB0aGUgTm9kZSBkcml2ZXIsIHNvIGl0IHdvbid0IHdvcmtcbiAgICAgIC8vIHNlcnZlci1zaWRlLiBDb3VsZCBiZSBjb25mdXNpbmchXG4gICAgICAvLyBYWFggaXMgaXQgY29ycmVjdCB0aGF0IHdlIGRvbid0IGRvIGdlby1zdHVmZiBoZXJlP1xuICAgICAgc29ydEZ1bmN0aW9uID0gbmV3IE1pbmltb25nby5Tb3J0ZXIoYXJnLiRzb3J0KS5nZXRDb21wYXJhdG9yKCk7XG5cbiAgICAgIHRvUHVzaC5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKGVsZW1lbnQpICE9PSAzKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICAnJHB1c2ggbGlrZSBtb2RpZmllcnMgdXNpbmcgJHNvcnQgcmVxdWlyZSBhbGwgZWxlbWVudHMgdG8gYmUgJyArXG4gICAgICAgICAgICAnb2JqZWN0cycsXG4gICAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWN0dWFsbHkgcHVzaC5cbiAgICBpZiAocG9zaXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdG9QdXNoLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgIHRhcmdldFtmaWVsZF0ucHVzaChlbGVtZW50KTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzcGxpY2VBcmd1bWVudHMgPSBbcG9zaXRpb24sIDBdO1xuXG4gICAgICB0b1B1c2guZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgc3BsaWNlQXJndW1lbnRzLnB1c2goZWxlbWVudCk7XG4gICAgICB9KTtcblxuICAgICAgdGFyZ2V0W2ZpZWxkXS5zcGxpY2UoLi4uc3BsaWNlQXJndW1lbnRzKTtcbiAgICB9XG5cbiAgICAvLyBBY3R1YWxseSBzb3J0LlxuICAgIGlmIChzb3J0RnVuY3Rpb24pIHtcbiAgICAgIHRhcmdldFtmaWVsZF0uc29ydChzb3J0RnVuY3Rpb24pO1xuICAgIH1cblxuICAgIC8vIEFjdHVhbGx5IHNsaWNlLlxuICAgIGlmIChzbGljZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoc2xpY2UgPT09IDApIHtcbiAgICAgICAgdGFyZ2V0W2ZpZWxkXSA9IFtdOyAvLyBkaWZmZXJzIGZyb20gQXJyYXkuc2xpY2UhXG4gICAgICB9IGVsc2UgaWYgKHNsaWNlIDwgMCkge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gdGFyZ2V0W2ZpZWxkXS5zbGljZShzbGljZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gdGFyZ2V0W2ZpZWxkXS5zbGljZSgwLCBzbGljZSk7XG4gICAgICB9XG4gICAgfVxuICB9LFxuICAkcHVzaEFsbCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAoISh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkcHVzaEFsbC9wdWxsQWxsIGFsbG93ZWQgZm9yIGFycmF5cyBvbmx5Jyk7XG4gICAgfVxuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKGFyZyk7XG5cbiAgICBjb25zdCB0b1B1c2ggPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgaWYgKHRvUHVzaCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgIH0gZWxzZSBpZiAoISh0b1B1c2ggaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnQ2Fubm90IGFwcGx5ICRwdXNoQWxsIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRvUHVzaC5wdXNoKC4uLmFyZyk7XG4gICAgfVxuICB9LFxuICAkYWRkVG9TZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgbGV0IGlzRWFjaCA9IGZhbHNlO1xuXG4gICAgaWYgKHR5cGVvZiBhcmcgPT09ICdvYmplY3QnKSB7XG4gICAgICAvLyBjaGVjayBpZiBmaXJzdCBrZXkgaXMgJyRlYWNoJ1xuICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKGFyZyk7XG4gICAgICBpZiAoa2V5c1swXSA9PT0gJyRlYWNoJykge1xuICAgICAgICBpc0VhY2ggPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHZhbHVlcyA9IGlzRWFjaCA/IGFyZy4kZWFjaCA6IFthcmddO1xuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKHZhbHVlcyk7XG5cbiAgICBjb25zdCB0b0FkZCA9IHRhcmdldFtmaWVsZF07XG4gICAgaWYgKHRvQWRkID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSB2YWx1ZXM7XG4gICAgfSBlbHNlIGlmICghKHRvQWRkIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBhcHBseSAkYWRkVG9TZXQgbW9kaWZpZXIgdG8gbm9uLWFycmF5JyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFsdWVzLmZvckVhY2godmFsdWUgPT4ge1xuICAgICAgICBpZiAodG9BZGQuc29tZShlbGVtZW50ID0+IExvY2FsQ29sbGVjdGlvbi5fZi5fZXF1YWwodmFsdWUsIGVsZW1lbnQpKSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRvQWRkLnB1c2godmFsdWUpO1xuICAgICAgfSk7XG4gICAgfVxuICB9LFxuICAkcG9wKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRvUG9wID0gdGFyZ2V0W2ZpZWxkXTtcblxuICAgIGlmICh0b1BvcCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEodG9Qb3AgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdDYW5ub3QgYXBwbHkgJHBvcCBtb2RpZmllciB0byBub24tYXJyYXknLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGFyZyA9PT0gJ251bWJlcicgJiYgYXJnIDwgMCkge1xuICAgICAgdG9Qb3Auc3BsaWNlKDAsIDEpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0b1BvcC5wb3AoKTtcbiAgICB9XG4gIH0sXG4gICRwdWxsKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRvUHVsbCA9IHRhcmdldFtmaWVsZF07XG4gICAgaWYgKHRvUHVsbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEodG9QdWxsIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBhcHBseSAkcHVsbC9wdWxsQWxsIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgbGV0IG91dDtcbiAgICBpZiAoYXJnICE9IG51bGwgJiYgdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgIShhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIC8vIFhYWCB3b3VsZCBiZSBtdWNoIG5pY2VyIHRvIGNvbXBpbGUgdGhpcyBvbmNlLCByYXRoZXIgdGhhblxuICAgICAgLy8gZm9yIGVhY2ggZG9jdW1lbnQgd2UgbW9kaWZ5Li4gYnV0IHVzdWFsbHkgd2UncmUgbm90XG4gICAgICAvLyBtb2RpZnlpbmcgdGhhdCBtYW55IGRvY3VtZW50cywgc28gd2UnbGwgbGV0IGl0IHNsaWRlIGZvclxuICAgICAgLy8gbm93XG5cbiAgICAgIC8vIFhYWCBNaW5pbW9uZ28uTWF0Y2hlciBpc24ndCB1cCBmb3IgdGhlIGpvYiwgYmVjYXVzZSB3ZSBuZWVkXG4gICAgICAvLyB0byBwZXJtaXQgc3R1ZmYgbGlrZSB7JHB1bGw6IHthOiB7JGd0OiA0fX19Li4gc29tZXRoaW5nXG4gICAgICAvLyBsaWtlIHskZ3Q6IDR9IGlzIG5vdCBub3JtYWxseSBhIGNvbXBsZXRlIHNlbGVjdG9yLlxuICAgICAgLy8gc2FtZSBpc3N1ZSBhcyAkZWxlbU1hdGNoIHBvc3NpYmx5P1xuICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihhcmcpO1xuXG4gICAgICBvdXQgPSB0b1B1bGwuZmlsdGVyKGVsZW1lbnQgPT4gIW1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGVsZW1lbnQpLnJlc3VsdCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dCA9IHRvUHVsbC5maWx0ZXIoZWxlbWVudCA9PiAhTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbChlbGVtZW50LCBhcmcpKTtcbiAgICB9XG5cbiAgICB0YXJnZXRbZmllbGRdID0gb3V0O1xuICB9LFxuICAkcHVsbEFsbCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAoISh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnTW9kaWZpZXIgJHB1c2hBbGwvcHVsbEFsbCBhbGxvd2VkIGZvciBhcnJheXMgb25seScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKHRhcmdldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdG9QdWxsID0gdGFyZ2V0W2ZpZWxkXTtcblxuICAgIGlmICh0b1B1bGwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghKHRvUHVsbCBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdDYW5ub3QgYXBwbHkgJHB1bGwvcHVsbEFsbCBtb2RpZmllciB0byBub24tYXJyYXknLFxuICAgICAgICB7ZmllbGR9XG4gICAgICApO1xuICAgIH1cblxuICAgIHRhcmdldFtmaWVsZF0gPSB0b1B1bGwuZmlsdGVyKG9iamVjdCA9PlxuICAgICAgIWFyZy5zb21lKGVsZW1lbnQgPT4gTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbChvYmplY3QsIGVsZW1lbnQpKVxuICAgICk7XG4gIH0sXG4gICRiaXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgLy8gWFhYIG1vbmdvIG9ubHkgc3VwcG9ydHMgJGJpdCBvbiBpbnRlZ2VycywgYW5kIHdlIG9ubHkgc3VwcG9ydFxuICAgIC8vIG5hdGl2ZSBqYXZhc2NyaXB0IG51bWJlcnMgKGRvdWJsZXMpIHNvIGZhciwgc28gd2UgY2FuJ3Qgc3VwcG9ydCAkYml0XG4gICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRiaXQgaXMgbm90IHN1cHBvcnRlZCcsIHtmaWVsZH0pO1xuICB9LFxuICAkdigpIHtcbiAgICAvLyBBcyBkaXNjdXNzZWQgaW4gaHR0cHM6Ly9naXRodWIuY29tL21ldGVvci9tZXRlb3IvaXNzdWVzLzk2MjMsXG4gICAgLy8gdGhlIGAkdmAgb3BlcmF0b3IgaXMgbm90IG5lZWRlZCBieSBNZXRlb3IsIGJ1dCBwcm9ibGVtcyBjYW4gb2NjdXIgaWZcbiAgICAvLyBpdCdzIG5vdCBhdCBsZWFzdCBjYWxsYWJsZSAoYXMgb2YgTW9uZ28gPj0gMy42KS4gSXQncyBkZWZpbmVkIGhlcmUgYXNcbiAgICAvLyBhIG5vLW9wIHRvIHdvcmsgYXJvdW5kIHRoZXNlIHByb2JsZW1zLlxuICB9XG59O1xuXG5jb25zdCBOT19DUkVBVEVfTU9ESUZJRVJTID0ge1xuICAkcG9wOiB0cnVlLFxuICAkcHVsbDogdHJ1ZSxcbiAgJHB1bGxBbGw6IHRydWUsXG4gICRyZW5hbWU6IHRydWUsXG4gICR1bnNldDogdHJ1ZVxufTtcblxuLy8gTWFrZSBzdXJlIGZpZWxkIG5hbWVzIGRvIG5vdCBjb250YWluIE1vbmdvIHJlc3RyaWN0ZWRcbi8vIGNoYXJhY3RlcnMgKCcuJywgJyQnLCAnXFwwJykuXG4vLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9saW1pdHMvI1Jlc3RyaWN0aW9ucy1vbi1GaWVsZC1OYW1lc1xuY29uc3QgaW52YWxpZENoYXJNc2cgPSB7XG4gICQ6ICdzdGFydCB3aXRoIFxcJyRcXCcnLFxuICAnLic6ICdjb250YWluIFxcJy5cXCcnLFxuICAnXFwwJzogJ2NvbnRhaW4gbnVsbCBieXRlcydcbn07XG5cbi8vIGNoZWNrcyBpZiBhbGwgZmllbGQgbmFtZXMgaW4gYW4gb2JqZWN0IGFyZSB2YWxpZFxuZnVuY3Rpb24gYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKGRvYykge1xuICBpZiAoZG9jICYmIHR5cGVvZiBkb2MgPT09ICdvYmplY3QnKSB7XG4gICAgSlNPTi5zdHJpbmdpZnkoZG9jLCAoa2V5LCB2YWx1ZSkgPT4ge1xuICAgICAgYXNzZXJ0SXNWYWxpZEZpZWxkTmFtZShrZXkpO1xuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFzc2VydElzVmFsaWRGaWVsZE5hbWUoa2V5KSB7XG4gIGxldCBtYXRjaDtcbiAgaWYgKHR5cGVvZiBrZXkgPT09ICdzdHJpbmcnICYmIChtYXRjaCA9IGtleS5tYXRjaCgvXlxcJHxcXC58XFwwLykpKSB7XG4gICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoYEtleSAke2tleX0gbXVzdCBub3QgJHtpbnZhbGlkQ2hhck1zZ1ttYXRjaFswXV19YCk7XG4gIH1cbn1cblxuLy8gZm9yIGEuYi5jLjIuZC5lLCBrZXlwYXJ0cyBzaG91bGQgYmUgWydhJywgJ2InLCAnYycsICcyJywgJ2QnLCAnZSddLFxuLy8gYW5kIHRoZW4geW91IHdvdWxkIG9wZXJhdGUgb24gdGhlICdlJyBwcm9wZXJ0eSBvZiB0aGUgcmV0dXJuZWRcbi8vIG9iamVjdC5cbi8vXG4vLyBpZiBvcHRpb25zLm5vQ3JlYXRlIGlzIGZhbHNleSwgY3JlYXRlcyBpbnRlcm1lZGlhdGUgbGV2ZWxzIG9mXG4vLyBzdHJ1Y3R1cmUgYXMgbmVjZXNzYXJ5LCBsaWtlIG1rZGlyIC1wIChhbmQgcmFpc2VzIGFuIGV4Y2VwdGlvbiBpZlxuLy8gdGhhdCB3b3VsZCBtZWFuIGdpdmluZyBhIG5vbi1udW1lcmljIHByb3BlcnR5IHRvIGFuIGFycmF5LikgaWZcbi8vIG9wdGlvbnMubm9DcmVhdGUgaXMgdHJ1ZSwgcmV0dXJuIHVuZGVmaW5lZCBpbnN0ZWFkLlxuLy9cbi8vIG1heSBtb2RpZnkgdGhlIGxhc3QgZWxlbWVudCBvZiBrZXlwYXJ0cyB0byBzaWduYWwgdG8gdGhlIGNhbGxlciB0aGF0IGl0IG5lZWRzXG4vLyB0byB1c2UgYSBkaWZmZXJlbnQgdmFsdWUgdG8gaW5kZXggaW50byB0aGUgcmV0dXJuZWQgb2JqZWN0IChmb3IgZXhhbXBsZSxcbi8vIFsnYScsICcwMSddIC0+IFsnYScsIDFdKS5cbi8vXG4vLyBpZiBmb3JiaWRBcnJheSBpcyB0cnVlLCByZXR1cm4gbnVsbCBpZiB0aGUga2V5cGF0aCBnb2VzIHRocm91Z2ggYW4gYXJyYXkuXG4vL1xuLy8gaWYgb3B0aW9ucy5hcnJheUluZGljZXMgaXMgc2V0LCB1c2UgaXRzIGZpcnN0IGVsZW1lbnQgZm9yIHRoZSAoZmlyc3QpICckJyBpblxuLy8gdGhlIHBhdGguXG5mdW5jdGlvbiBmaW5kTW9kVGFyZ2V0KGRvYywga2V5cGFydHMsIG9wdGlvbnMgPSB7fSkge1xuICBsZXQgdXNlZEFycmF5SW5kZXggPSBmYWxzZTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGtleXBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGFzdCA9IGkgPT09IGtleXBhcnRzLmxlbmd0aCAtIDE7XG4gICAgbGV0IGtleXBhcnQgPSBrZXlwYXJ0c1tpXTtcblxuICAgIGlmICghaXNJbmRleGFibGUoZG9jKSkge1xuICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUpIHtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZXJyb3IgPSBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgYGNhbm5vdCB1c2UgdGhlIHBhcnQgJyR7a2V5cGFydH0nIHRvIHRyYXZlcnNlICR7ZG9jfWBcbiAgICAgICk7XG4gICAgICBlcnJvci5zZXRQcm9wZXJ0eUVycm9yID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGlmIChkb2MgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgaWYgKG9wdGlvbnMuZm9yYmlkQXJyYXkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChrZXlwYXJ0ID09PSAnJCcpIHtcbiAgICAgICAgaWYgKHVzZWRBcnJheUluZGV4KSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ1RvbyBtYW55IHBvc2l0aW9uYWwgKGkuZS4gXFwnJFxcJykgZWxlbWVudHMnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghb3B0aW9ucy5hcnJheUluZGljZXMgfHwgIW9wdGlvbnMuYXJyYXlJbmRpY2VzLmxlbmd0aCkge1xuICAgICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgICAgJ1RoZSBwb3NpdGlvbmFsIG9wZXJhdG9yIGRpZCBub3QgZmluZCB0aGUgbWF0Y2ggbmVlZGVkIGZyb20gdGhlICcgK1xuICAgICAgICAgICAgJ3F1ZXJ5J1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBrZXlwYXJ0ID0gb3B0aW9ucy5hcnJheUluZGljZXNbMF07XG4gICAgICAgIHVzZWRBcnJheUluZGV4ID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSBpZiAoaXNOdW1lcmljS2V5KGtleXBhcnQpKSB7XG4gICAgICAgIGtleXBhcnQgPSBwYXJzZUludChrZXlwYXJ0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChvcHRpb25zLm5vQ3JlYXRlKSB7XG4gICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgIGBjYW4ndCBhcHBlbmQgdG8gYXJyYXkgdXNpbmcgc3RyaW5nIGZpZWxkIG5hbWUgWyR7a2V5cGFydH1dYFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAobGFzdCkge1xuICAgICAgICBrZXlwYXJ0c1tpXSA9IGtleXBhcnQ7IC8vIGhhbmRsZSAnYS4wMSdcbiAgICAgIH1cblxuICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUgJiYga2V5cGFydCA+PSBkb2MubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIHdoaWxlIChkb2MubGVuZ3RoIDwga2V5cGFydCkge1xuICAgICAgICBkb2MucHVzaChudWxsKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFsYXN0KSB7XG4gICAgICAgIGlmIChkb2MubGVuZ3RoID09PSBrZXlwYXJ0KSB7XG4gICAgICAgICAgZG9jLnB1c2goe30pO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBkb2Nba2V5cGFydF0gIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICBgY2FuJ3QgbW9kaWZ5IGZpZWxkICcke2tleXBhcnRzW2kgKyAxXX0nIG9mIGxpc3QgdmFsdWUgYCArXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShkb2Nba2V5cGFydF0pXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBhc3NlcnRJc1ZhbGlkRmllbGROYW1lKGtleXBhcnQpO1xuXG4gICAgICBpZiAoIShrZXlwYXJ0IGluIGRvYykpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUpIHtcbiAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFsYXN0KSB7XG4gICAgICAgICAgZG9jW2tleXBhcnRdID0ge307XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobGFzdCkge1xuICAgICAgcmV0dXJuIGRvYztcbiAgICB9XG5cbiAgICBkb2MgPSBkb2Nba2V5cGFydF07XG4gIH1cblxuICAvLyBub3RyZWFjaGVkXG59XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5pbXBvcnQge1xuICBjb21waWxlRG9jdW1lbnRTZWxlY3RvcixcbiAgaGFzT3duLFxuICBub3RoaW5nTWF0Y2hlcixcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG5jb25zdCBEZWNpbWFsID0gUGFja2FnZVsnbW9uZ28tZGVjaW1hbCddPy5EZWNpbWFsIHx8IGNsYXNzIERlY2ltYWxTdHViIHt9XG5cbi8vIFRoZSBtaW5pbW9uZ28gc2VsZWN0b3IgY29tcGlsZXIhXG5cbi8vIFRlcm1pbm9sb2d5OlxuLy8gIC0gYSAnc2VsZWN0b3InIGlzIHRoZSBFSlNPTiBvYmplY3QgcmVwcmVzZW50aW5nIGEgc2VsZWN0b3Jcbi8vICAtIGEgJ21hdGNoZXInIGlzIGl0cyBjb21waWxlZCBmb3JtICh3aGV0aGVyIGEgZnVsbCBNaW5pbW9uZ28uTWF0Y2hlclxuLy8gICAgb2JqZWN0IG9yIG9uZSBvZiB0aGUgY29tcG9uZW50IGxhbWJkYXMgdGhhdCBtYXRjaGVzIHBhcnRzIG9mIGl0KVxuLy8gIC0gYSAncmVzdWx0IG9iamVjdCcgaXMgYW4gb2JqZWN0IHdpdGggYSAncmVzdWx0JyBmaWVsZCBhbmQgbWF5YmVcbi8vICAgIGRpc3RhbmNlIGFuZCBhcnJheUluZGljZXMuXG4vLyAgLSBhICdicmFuY2hlZCB2YWx1ZScgaXMgYW4gb2JqZWN0IHdpdGggYSAndmFsdWUnIGZpZWxkIGFuZCBtYXliZVxuLy8gICAgJ2RvbnRJdGVyYXRlJyBhbmQgJ2FycmF5SW5kaWNlcycuXG4vLyAgLSBhICdkb2N1bWVudCcgaXMgYSB0b3AtbGV2ZWwgb2JqZWN0IHRoYXQgY2FuIGJlIHN0b3JlZCBpbiBhIGNvbGxlY3Rpb24uXG4vLyAgLSBhICdsb29rdXAgZnVuY3Rpb24nIGlzIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyBpbiBhIGRvY3VtZW50IGFuZCByZXR1cm5zXG4vLyAgICBhbiBhcnJheSBvZiAnYnJhbmNoZWQgdmFsdWVzJy5cbi8vICAtIGEgJ2JyYW5jaGVkIG1hdGNoZXInIG1hcHMgZnJvbSBhbiBhcnJheSBvZiBicmFuY2hlZCB2YWx1ZXMgdG8gYSByZXN1bHRcbi8vICAgIG9iamVjdC5cbi8vICAtIGFuICdlbGVtZW50IG1hdGNoZXInIG1hcHMgZnJvbSBhIHNpbmdsZSB2YWx1ZSB0byBhIGJvb2wuXG5cbi8vIE1haW4gZW50cnkgcG9pbnQuXG4vLyAgIHZhciBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHthOiB7JGd0OiA1fX0pO1xuLy8gICBpZiAobWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoe2E6IDd9KSkgLi4uXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNYXRjaGVyIHtcbiAgY29uc3RydWN0b3Ioc2VsZWN0b3IsIGlzVXBkYXRlKSB7XG4gICAgLy8gQSBzZXQgKG9iamVjdCBtYXBwaW5nIHN0cmluZyAtPiAqKSBvZiBhbGwgb2YgdGhlIGRvY3VtZW50IHBhdGhzIGxvb2tlZFxuICAgIC8vIGF0IGJ5IHRoZSBzZWxlY3Rvci4gQWxzbyBpbmNsdWRlcyB0aGUgZW1wdHkgc3RyaW5nIGlmIGl0IG1heSBsb29rIGF0IGFueVxuICAgIC8vIHBhdGggKGVnLCAkd2hlcmUpLlxuICAgIHRoaXMuX3BhdGhzID0ge307XG4gICAgLy8gU2V0IHRvIHRydWUgaWYgY29tcGlsYXRpb24gZmluZHMgYSAkbmVhci5cbiAgICB0aGlzLl9oYXNHZW9RdWVyeSA9IGZhbHNlO1xuICAgIC8vIFNldCB0byB0cnVlIGlmIGNvbXBpbGF0aW9uIGZpbmRzIGEgJHdoZXJlLlxuICAgIHRoaXMuX2hhc1doZXJlID0gZmFsc2U7XG4gICAgLy8gU2V0IHRvIGZhbHNlIGlmIGNvbXBpbGF0aW9uIGZpbmRzIGFueXRoaW5nIG90aGVyIHRoYW4gYSBzaW1wbGUgZXF1YWxpdHlcbiAgICAvLyBvciBvbmUgb3IgbW9yZSBvZiAnJGd0JywgJyRndGUnLCAnJGx0JywgJyRsdGUnLCAnJG5lJywgJyRpbicsICckbmluJyB1c2VkXG4gICAgLy8gd2l0aCBzY2FsYXJzIGFzIG9wZXJhbmRzLlxuICAgIHRoaXMuX2lzU2ltcGxlID0gdHJ1ZTtcbiAgICAvLyBTZXQgdG8gYSBkdW1teSBkb2N1bWVudCB3aGljaCBhbHdheXMgbWF0Y2hlcyB0aGlzIE1hdGNoZXIuIE9yIHNldCB0byBudWxsXG4gICAgLy8gaWYgc3VjaCBkb2N1bWVudCBpcyB0b28gaGFyZCB0byBmaW5kLlxuICAgIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSB1bmRlZmluZWQ7XG4gICAgLy8gQSBjbG9uZSBvZiB0aGUgb3JpZ2luYWwgc2VsZWN0b3IuIEl0IG1heSBqdXN0IGJlIGEgZnVuY3Rpb24gaWYgdGhlIHVzZXJcbiAgICAvLyBwYXNzZWQgaW4gYSBmdW5jdGlvbjsgb3RoZXJ3aXNlIGlzIGRlZmluaXRlbHkgYW4gb2JqZWN0IChlZywgSURzIGFyZVxuICAgIC8vIHRyYW5zbGF0ZWQgaW50byB7X2lkOiBJRH0gZmlyc3QuIFVzZWQgYnkgY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIgYW5kXG4gICAgLy8gU29ydGVyLl91c2VXaXRoTWF0Y2hlci5cbiAgICB0aGlzLl9zZWxlY3RvciA9IG51bGw7XG4gICAgdGhpcy5fZG9jTWF0Y2hlciA9IHRoaXMuX2NvbXBpbGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgLy8gU2V0IHRvIHRydWUgaWYgc2VsZWN0aW9uIGlzIGRvbmUgZm9yIGFuIHVwZGF0ZSBvcGVyYXRpb25cbiAgICAvLyBEZWZhdWx0IGlzIGZhbHNlXG4gICAgLy8gVXNlZCBmb3IgJG5lYXIgYXJyYXkgdXBkYXRlIChpc3N1ZSAjMzU5OSlcbiAgICB0aGlzLl9pc1VwZGF0ZSA9IGlzVXBkYXRlO1xuICB9XG5cbiAgZG9jdW1lbnRNYXRjaGVzKGRvYykge1xuICAgIGlmIChkb2MgIT09IE9iamVjdChkb2MpKSB7XG4gICAgICB0aHJvdyBFcnJvcignZG9jdW1lbnRNYXRjaGVzIG5lZWRzIGEgZG9jdW1lbnQnKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fZG9jTWF0Y2hlcihkb2MpO1xuICB9XG5cbiAgaGFzR2VvUXVlcnkoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2hhc0dlb1F1ZXJ5O1xuICB9XG5cbiAgaGFzV2hlcmUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2hhc1doZXJlO1xuICB9XG5cbiAgaXNTaW1wbGUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2lzU2ltcGxlO1xuICB9XG5cbiAgLy8gR2l2ZW4gYSBzZWxlY3RvciwgcmV0dXJuIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyBvbmUgYXJndW1lbnQsIGFcbiAgLy8gZG9jdW1lbnQuIEl0IHJldHVybnMgYSByZXN1bHQgb2JqZWN0LlxuICBfY29tcGlsZVNlbGVjdG9yKHNlbGVjdG9yKSB7XG4gICAgLy8geW91IGNhbiBwYXNzIGEgbGl0ZXJhbCBmdW5jdGlvbiBpbnN0ZWFkIG9mIGEgc2VsZWN0b3JcbiAgICBpZiAoc2VsZWN0b3IgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgdGhpcy5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICAgIHRoaXMuX3NlbGVjdG9yID0gc2VsZWN0b3I7XG4gICAgICB0aGlzLl9yZWNvcmRQYXRoVXNlZCgnJyk7XG5cbiAgICAgIHJldHVybiBkb2MgPT4gKHtyZXN1bHQ6ICEhc2VsZWN0b3IuY2FsbChkb2MpfSk7XG4gICAgfVxuXG4gICAgLy8gc2hvcnRoYW5kIC0tIHNjYWxhciBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKSB7XG4gICAgICB0aGlzLl9zZWxlY3RvciA9IHtfaWQ6IHNlbGVjdG9yfTtcbiAgICAgIHRoaXMuX3JlY29yZFBhdGhVc2VkKCdfaWQnKTtcblxuICAgICAgcmV0dXJuIGRvYyA9PiAoe3Jlc3VsdDogRUpTT04uZXF1YWxzKGRvYy5faWQsIHNlbGVjdG9yKX0pO1xuICAgIH1cblxuICAgIC8vIHByb3RlY3QgYWdhaW5zdCBkYW5nZXJvdXMgc2VsZWN0b3JzLiAgZmFsc2V5IGFuZCB7X2lkOiBmYWxzZXl9IGFyZSBib3RoXG4gICAgLy8gbGlrZWx5IHByb2dyYW1tZXIgZXJyb3IsIGFuZCBub3Qgd2hhdCB5b3Ugd2FudCwgcGFydGljdWxhcmx5IGZvclxuICAgIC8vIGRlc3RydWN0aXZlIG9wZXJhdGlvbnMuXG4gICAgaWYgKCFzZWxlY3RvciB8fCBoYXNPd24uY2FsbChzZWxlY3RvciwgJ19pZCcpICYmICFzZWxlY3Rvci5faWQpIHtcbiAgICAgIHRoaXMuX2lzU2ltcGxlID0gZmFsc2U7XG4gICAgICByZXR1cm4gbm90aGluZ01hdGNoZXI7XG4gICAgfVxuXG4gICAgLy8gVG9wIGxldmVsIGNhbid0IGJlIGFuIGFycmF5IG9yIHRydWUgb3IgYmluYXJ5LlxuICAgIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdG9yKSB8fFxuICAgICAgICBFSlNPTi5pc0JpbmFyeShzZWxlY3RvcikgfHxcbiAgICAgICAgdHlwZW9mIHNlbGVjdG9yID09PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBzZWxlY3RvcjogJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zZWxlY3RvciA9IEVKU09OLmNsb25lKHNlbGVjdG9yKTtcblxuICAgIHJldHVybiBjb21waWxlRG9jdW1lbnRTZWxlY3RvcihzZWxlY3RvciwgdGhpcywge2lzUm9vdDogdHJ1ZX0pO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIGxpc3Qgb2Yga2V5IHBhdGhzIHRoZSBnaXZlbiBzZWxlY3RvciBpcyBsb29raW5nIGZvci4gSXQgaW5jbHVkZXNcbiAgLy8gdGhlIGVtcHR5IHN0cmluZyBpZiB0aGVyZSBpcyBhICR3aGVyZS5cbiAgX2dldFBhdGhzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0aGlzLl9wYXRocyk7XG4gIH1cblxuICBfcmVjb3JkUGF0aFVzZWQocGF0aCkge1xuICAgIHRoaXMuX3BhdGhzW3BhdGhdID0gdHJ1ZTtcbiAgfVxufVxuXG4vLyBoZWxwZXJzIHVzZWQgYnkgY29tcGlsZWQgc2VsZWN0b3IgY29kZVxuTG9jYWxDb2xsZWN0aW9uLl9mID0ge1xuICAvLyBYWFggZm9yIF9hbGwgYW5kIF9pbiwgY29uc2lkZXIgYnVpbGRpbmcgJ2lucXVlcnknIGF0IGNvbXBpbGUgdGltZS4uXG4gIF90eXBlKHYpIHtcbiAgICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInKSB7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gMjtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdib29sZWFuJykge1xuICAgICAgcmV0dXJuIDg7XG4gICAgfVxuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgIHJldHVybiA0O1xuICAgIH1cblxuICAgIGlmICh2ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gMTA7XG4gICAgfVxuXG4gICAgLy8gbm90ZSB0aGF0IHR5cGVvZigveC8pID09PSBcIm9iamVjdFwiXG4gICAgaWYgKHYgaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgIHJldHVybiAxMTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiAxMztcbiAgICB9XG5cbiAgICBpZiAodiBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHJldHVybiA5O1xuICAgIH1cblxuICAgIGlmIChFSlNPTi5pc0JpbmFyeSh2KSkge1xuICAgICAgcmV0dXJuIDU7XG4gICAgfVxuXG4gICAgaWYgKHYgaW5zdGFuY2VvZiBNb25nb0lELk9iamVjdElEKSB7XG4gICAgICByZXR1cm4gNztcbiAgICB9XG5cbiAgICBpZiAodiBpbnN0YW5jZW9mIERlY2ltYWwpIHtcbiAgICAgIHJldHVybiAxO1xuICAgIH1cblxuICAgIC8vIG9iamVjdFxuICAgIHJldHVybiAzO1xuXG4gICAgLy8gWFhYIHN1cHBvcnQgc29tZS9hbGwgb2YgdGhlc2U6XG4gICAgLy8gMTQsIHN5bWJvbFxuICAgIC8vIDE1LCBqYXZhc2NyaXB0IGNvZGUgd2l0aCBzY29wZVxuICAgIC8vIDE2LCAxODogMzItYml0LzY0LWJpdCBpbnRlZ2VyXG4gICAgLy8gMTcsIHRpbWVzdGFtcFxuICAgIC8vIDI1NSwgbWlua2V5XG4gICAgLy8gMTI3LCBtYXhrZXlcbiAgfSxcblxuICAvLyBkZWVwIGVxdWFsaXR5IHRlc3Q6IHVzZSBmb3IgbGl0ZXJhbCBkb2N1bWVudCBhbmQgYXJyYXkgbWF0Y2hlc1xuICBfZXF1YWwoYSwgYikge1xuICAgIHJldHVybiBFSlNPTi5lcXVhbHMoYSwgYiwge2tleU9yZGVyU2Vuc2l0aXZlOiB0cnVlfSk7XG4gIH0sXG5cbiAgLy8gbWFwcyBhIHR5cGUgY29kZSB0byBhIHZhbHVlIHRoYXQgY2FuIGJlIHVzZWQgdG8gc29ydCB2YWx1ZXMgb2YgZGlmZmVyZW50XG4gIC8vIHR5cGVzXG4gIF90eXBlb3JkZXIodCkge1xuICAgIC8vIGh0dHA6Ly93d3cubW9uZ29kYi5vcmcvZGlzcGxheS9ET0NTL1doYXQraXMrdGhlK0NvbXBhcmUrT3JkZXIrZm9yK0JTT04rVHlwZXNcbiAgICAvLyBYWFggd2hhdCBpcyB0aGUgY29ycmVjdCBzb3J0IHBvc2l0aW9uIGZvciBKYXZhc2NyaXB0IGNvZGU/XG4gICAgLy8gKCcxMDAnIGluIHRoZSBtYXRyaXggYmVsb3cpXG4gICAgLy8gWFhYIG1pbmtleS9tYXhrZXlcbiAgICByZXR1cm4gW1xuICAgICAgLTEsICAvLyAobm90IGEgdHlwZSlcbiAgICAgIDEsICAgLy8gbnVtYmVyXG4gICAgICAyLCAgIC8vIHN0cmluZ1xuICAgICAgMywgICAvLyBvYmplY3RcbiAgICAgIDQsICAgLy8gYXJyYXlcbiAgICAgIDUsICAgLy8gYmluYXJ5XG4gICAgICAtMSwgIC8vIGRlcHJlY2F0ZWRcbiAgICAgIDYsICAgLy8gT2JqZWN0SURcbiAgICAgIDcsICAgLy8gYm9vbFxuICAgICAgOCwgICAvLyBEYXRlXG4gICAgICAwLCAgIC8vIG51bGxcbiAgICAgIDksICAgLy8gUmVnRXhwXG4gICAgICAtMSwgIC8vIGRlcHJlY2F0ZWRcbiAgICAgIDEwMCwgLy8gSlMgY29kZVxuICAgICAgMiwgICAvLyBkZXByZWNhdGVkIChzeW1ib2wpXG4gICAgICAxMDAsIC8vIEpTIGNvZGVcbiAgICAgIDEsICAgLy8gMzItYml0IGludFxuICAgICAgOCwgICAvLyBNb25nbyB0aW1lc3RhbXBcbiAgICAgIDEgICAgLy8gNjQtYml0IGludFxuICAgIF1bdF07XG4gIH0sXG5cbiAgLy8gY29tcGFyZSB0d28gdmFsdWVzIG9mIHVua25vd24gdHlwZSBhY2NvcmRpbmcgdG8gQlNPTiBvcmRlcmluZ1xuICAvLyBzZW1hbnRpY3MuIChhcyBhbiBleHRlbnNpb24sIGNvbnNpZGVyICd1bmRlZmluZWQnIHRvIGJlIGxlc3MgdGhhblxuICAvLyBhbnkgb3RoZXIgdmFsdWUuKSByZXR1cm4gbmVnYXRpdmUgaWYgYSBpcyBsZXNzLCBwb3NpdGl2ZSBpZiBiIGlzXG4gIC8vIGxlc3MsIG9yIDAgaWYgZXF1YWxcbiAgX2NtcChhLCBiKSB7XG4gICAgaWYgKGEgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIGIgPT09IHVuZGVmaW5lZCA/IDAgOiAtMTtcbiAgICB9XG5cbiAgICBpZiAoYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG5cbiAgICBsZXQgdGEgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUoYSk7XG4gICAgbGV0IHRiID0gTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKGIpO1xuXG4gICAgY29uc3Qgb2EgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGVvcmRlcih0YSk7XG4gICAgY29uc3Qgb2IgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGVvcmRlcih0Yik7XG5cbiAgICBpZiAob2EgIT09IG9iKSB7XG4gICAgICByZXR1cm4gb2EgPCBvYiA/IC0xIDogMTtcbiAgICB9XG5cbiAgICAvLyBYWFggbmVlZCB0byBpbXBsZW1lbnQgdGhpcyBpZiB3ZSBpbXBsZW1lbnQgU3ltYm9sIG9yIGludGVnZXJzLCBvclxuICAgIC8vIFRpbWVzdGFtcFxuICAgIGlmICh0YSAhPT0gdGIpIHtcbiAgICAgIHRocm93IEVycm9yKCdNaXNzaW5nIHR5cGUgY29lcmNpb24gbG9naWMgaW4gX2NtcCcpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gNykgeyAvLyBPYmplY3RJRFxuICAgICAgLy8gQ29udmVydCB0byBzdHJpbmcuXG4gICAgICB0YSA9IHRiID0gMjtcbiAgICAgIGEgPSBhLnRvSGV4U3RyaW5nKCk7XG4gICAgICBiID0gYi50b0hleFN0cmluZygpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gOSkgeyAvLyBEYXRlXG4gICAgICAvLyBDb252ZXJ0IHRvIG1pbGxpcy5cbiAgICAgIHRhID0gdGIgPSAxO1xuICAgICAgYSA9IGlzTmFOKGEpID8gMCA6IGEuZ2V0VGltZSgpO1xuICAgICAgYiA9IGlzTmFOKGIpID8gMCA6IGIuZ2V0VGltZSgpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gMSkgeyAvLyBkb3VibGVcbiAgICAgIGlmIChhIGluc3RhbmNlb2YgRGVjaW1hbCkge1xuICAgICAgICByZXR1cm4gYS5taW51cyhiKS50b051bWJlcigpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGEgLSBiO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0YiA9PT0gMikgLy8gc3RyaW5nXG4gICAgICByZXR1cm4gYSA8IGIgPyAtMSA6IGEgPT09IGIgPyAwIDogMTtcblxuICAgIGlmICh0YSA9PT0gMykgeyAvLyBPYmplY3RcbiAgICAgIC8vIHRoaXMgY291bGQgYmUgbXVjaCBtb3JlIGVmZmljaWVudCBpbiB0aGUgZXhwZWN0ZWQgY2FzZSAuLi5cbiAgICAgIGNvbnN0IHRvQXJyYXkgPSBvYmplY3QgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBbXTtcblxuICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICByZXN1bHQucHVzaChrZXksIG9iamVjdFtrZXldKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcCh0b0FycmF5KGEpLCB0b0FycmF5KGIpKTtcbiAgICB9XG5cbiAgICBpZiAodGEgPT09IDQpIHsgLy8gQXJyYXlcbiAgICAgIGZvciAobGV0IGkgPSAwOyA7IGkrKykge1xuICAgICAgICBpZiAoaSA9PT0gYS5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm4gaSA9PT0gYi5sZW5ndGggPyAwIDogLTE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaSA9PT0gYi5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm4gMTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHMgPSBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcChhW2ldLCBiW2ldKTtcbiAgICAgICAgaWYgKHMgIT09IDApIHtcbiAgICAgICAgICByZXR1cm4gcztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0YSA9PT0gNSkgeyAvLyBiaW5hcnlcbiAgICAgIC8vIFN1cnByaXNpbmdseSwgYSBzbWFsbCBiaW5hcnkgYmxvYiBpcyBhbHdheXMgbGVzcyB0aGFuIGEgbGFyZ2Ugb25lIGluXG4gICAgICAvLyBNb25nby5cbiAgICAgIGlmIChhLmxlbmd0aCAhPT0gYi5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7XG4gICAgICB9XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYS5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoYVtpXSA8IGJbaV0pIHtcbiAgICAgICAgICByZXR1cm4gLTE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYVtpXSA+IGJbaV0pIHtcbiAgICAgICAgICByZXR1cm4gMTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gMDtcbiAgICB9XG5cbiAgICBpZiAodGEgPT09IDgpIHsgLy8gYm9vbGVhblxuICAgICAgaWYgKGEpIHtcbiAgICAgICAgcmV0dXJuIGIgPyAwIDogMTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGIgPyAtMSA6IDA7XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSAxMCkgLy8gbnVsbFxuICAgICAgcmV0dXJuIDA7XG5cbiAgICBpZiAodGEgPT09IDExKSAvLyByZWdleHBcbiAgICAgIHRocm93IEVycm9yKCdTb3J0aW5nIG5vdCBzdXBwb3J0ZWQgb24gcmVndWxhciBleHByZXNzaW9uJyk7IC8vIFhYWFxuXG4gICAgLy8gMTM6IGphdmFzY3JpcHQgY29kZVxuICAgIC8vIDE0OiBzeW1ib2xcbiAgICAvLyAxNTogamF2YXNjcmlwdCBjb2RlIHdpdGggc2NvcGVcbiAgICAvLyAxNjogMzItYml0IGludGVnZXJcbiAgICAvLyAxNzogdGltZXN0YW1wXG4gICAgLy8gMTg6IDY0LWJpdCBpbnRlZ2VyXG4gICAgLy8gMjU1OiBtaW5rZXlcbiAgICAvLyAxMjc6IG1heGtleVxuICAgIGlmICh0YSA9PT0gMTMpIC8vIGphdmFzY3JpcHQgY29kZVxuICAgICAgdGhyb3cgRXJyb3IoJ1NvcnRpbmcgbm90IHN1cHBvcnRlZCBvbiBKYXZhc2NyaXB0IGNvZGUnKTsgLy8gWFhYXG5cbiAgICB0aHJvdyBFcnJvcignVW5rbm93biB0eXBlIHRvIHNvcnQnKTtcbiAgfSxcbn07XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uXyBmcm9tICcuL2xvY2FsX2NvbGxlY3Rpb24uanMnO1xuaW1wb3J0IE1hdGNoZXIgZnJvbSAnLi9tYXRjaGVyLmpzJztcbmltcG9ydCBTb3J0ZXIgZnJvbSAnLi9zb3J0ZXIuanMnO1xuXG5Mb2NhbENvbGxlY3Rpb24gPSBMb2NhbENvbGxlY3Rpb25fO1xuTWluaW1vbmdvID0ge1xuICAgIExvY2FsQ29sbGVjdGlvbjogTG9jYWxDb2xsZWN0aW9uXyxcbiAgICBNYXRjaGVyLFxuICAgIFNvcnRlclxufTtcbiIsIi8vIE9ic2VydmVIYW5kbGU6IHRoZSByZXR1cm4gdmFsdWUgb2YgYSBsaXZlIHF1ZXJ5LlxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgT2JzZXJ2ZUhhbmRsZSB7fVxuIiwiaW1wb3J0IHtcbiAgRUxFTUVOVF9PUEVSQVRPUlMsXG4gIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIsXG4gIGV4cGFuZEFycmF5c0luQnJhbmNoZXMsXG4gIGhhc093bixcbiAgaXNPcGVyYXRvck9iamVjdCxcbiAgbWFrZUxvb2t1cEZ1bmN0aW9uLFxuICByZWdleHBFbGVtZW50TWF0Y2hlcixcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG4vLyBHaXZlIGEgc29ydCBzcGVjLCB3aGljaCBjYW4gYmUgaW4gYW55IG9mIHRoZXNlIGZvcm1zOlxuLy8gICB7XCJrZXkxXCI6IDEsIFwia2V5MlwiOiAtMX1cbi8vICAgW1tcImtleTFcIiwgXCJhc2NcIl0sIFtcImtleTJcIiwgXCJkZXNjXCJdXVxuLy8gICBbXCJrZXkxXCIsIFtcImtleTJcIiwgXCJkZXNjXCJdXVxuLy9cbi8vICguLiB3aXRoIHRoZSBmaXJzdCBmb3JtIGJlaW5nIGRlcGVuZGVudCBvbiB0aGUga2V5IGVudW1lcmF0aW9uXG4vLyBiZWhhdmlvciBvZiB5b3VyIGphdmFzY3JpcHQgVk0sIHdoaWNoIHVzdWFsbHkgZG9lcyB3aGF0IHlvdSBtZWFuIGluXG4vLyB0aGlzIGNhc2UgaWYgdGhlIGtleSBuYW1lcyBkb24ndCBsb29rIGxpa2UgaW50ZWdlcnMgLi4pXG4vL1xuLy8gcmV0dXJuIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyB0d28gb2JqZWN0cywgYW5kIHJldHVybnMgLTEgaWYgdGhlXG4vLyBmaXJzdCBvYmplY3QgY29tZXMgZmlyc3QgaW4gb3JkZXIsIDEgaWYgdGhlIHNlY29uZCBvYmplY3QgY29tZXNcbi8vIGZpcnN0LCBvciAwIGlmIG5laXRoZXIgb2JqZWN0IGNvbWVzIGJlZm9yZSB0aGUgb3RoZXIuXG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFNvcnRlciB7XG4gIGNvbnN0cnVjdG9yKHNwZWMpIHtcbiAgICB0aGlzLl9zb3J0U3BlY1BhcnRzID0gW107XG4gICAgdGhpcy5fc29ydEZ1bmN0aW9uID0gbnVsbDtcblxuICAgIGNvbnN0IGFkZFNwZWNQYXJ0ID0gKHBhdGgsIGFzY2VuZGluZykgPT4ge1xuICAgICAgaWYgKCFwYXRoKSB7XG4gICAgICAgIHRocm93IEVycm9yKCdzb3J0IGtleXMgbXVzdCBiZSBub24tZW1wdHknKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHBhdGguY2hhckF0KDApID09PSAnJCcpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYHVuc3VwcG9ydGVkIHNvcnQga2V5OiAke3BhdGh9YCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX3NvcnRTcGVjUGFydHMucHVzaCh7XG4gICAgICAgIGFzY2VuZGluZyxcbiAgICAgICAgbG9va3VwOiBtYWtlTG9va3VwRnVuY3Rpb24ocGF0aCwge2ZvclNvcnQ6IHRydWV9KSxcbiAgICAgICAgcGF0aFxuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGlmIChzcGVjIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgIHNwZWMuZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBlbGVtZW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIGFkZFNwZWNQYXJ0KGVsZW1lbnQsIHRydWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFkZFNwZWNQYXJ0KGVsZW1lbnRbMF0sIGVsZW1lbnRbMV0gIT09ICdkZXNjJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHNwZWMgPT09ICdvYmplY3QnKSB7XG4gICAgICBPYmplY3Qua2V5cyhzcGVjKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgIGFkZFNwZWNQYXJ0KGtleSwgc3BlY1trZXldID49IDApO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2Ygc3BlYyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fc29ydEZ1bmN0aW9uID0gc3BlYztcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgRXJyb3IoYEJhZCBzb3J0IHNwZWNpZmljYXRpb246ICR7SlNPTi5zdHJpbmdpZnkoc3BlYyl9YCk7XG4gICAgfVxuXG4gICAgLy8gSWYgYSBmdW5jdGlvbiBpcyBzcGVjaWZpZWQgZm9yIHNvcnRpbmcsIHdlIHNraXAgdGhlIHJlc3QuXG4gICAgaWYgKHRoaXMuX3NvcnRGdW5jdGlvbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFRvIGltcGxlbWVudCBhZmZlY3RlZEJ5TW9kaWZpZXIsIHdlIHBpZ2d5LWJhY2sgb24gdG9wIG9mIE1hdGNoZXInc1xuICAgIC8vIGFmZmVjdGVkQnlNb2RpZmllciBjb2RlOyB3ZSBjcmVhdGUgYSBzZWxlY3RvciB0aGF0IGlzIGFmZmVjdGVkIGJ5IHRoZVxuICAgIC8vIHNhbWUgbW9kaWZpZXJzIGFzIHRoaXMgc29ydCBvcmRlci4gVGhpcyBpcyBvbmx5IGltcGxlbWVudGVkIG9uIHRoZVxuICAgIC8vIHNlcnZlci5cbiAgICBpZiAodGhpcy5hZmZlY3RlZEJ5TW9kaWZpZXIpIHtcbiAgICAgIGNvbnN0IHNlbGVjdG9yID0ge307XG5cbiAgICAgIHRoaXMuX3NvcnRTcGVjUGFydHMuZm9yRWFjaChzcGVjID0+IHtcbiAgICAgICAgc2VsZWN0b3Jbc3BlYy5wYXRoXSA9IDE7XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5fc2VsZWN0b3JGb3JBZmZlY3RlZEJ5TW9kaWZpZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoc2VsZWN0b3IpO1xuICAgIH1cblxuICAgIHRoaXMuX2tleUNvbXBhcmF0b3IgPSBjb21wb3NlQ29tcGFyYXRvcnMoXG4gICAgICB0aGlzLl9zb3J0U3BlY1BhcnRzLm1hcCgoc3BlYywgaSkgPT4gdGhpcy5fa2V5RmllbGRDb21wYXJhdG9yKGkpKVxuICAgICk7XG4gIH1cblxuICBnZXRDb21wYXJhdG9yKG9wdGlvbnMpIHtcbiAgICAvLyBJZiBzb3J0IGlzIHNwZWNpZmllZCBvciBoYXZlIG5vIGRpc3RhbmNlcywganVzdCB1c2UgdGhlIGNvbXBhcmF0b3IgZnJvbVxuICAgIC8vIHRoZSBzb3VyY2Ugc3BlY2lmaWNhdGlvbiAod2hpY2ggZGVmYXVsdHMgdG8gXCJldmVyeXRoaW5nIGlzIGVxdWFsXCIuXG4gICAgLy8gaXNzdWUgIzM1OTlcbiAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9vcGVyYXRvci9xdWVyeS9uZWFyLyNzb3J0LW9wZXJhdGlvblxuICAgIC8vIHNvcnQgZWZmZWN0aXZlbHkgb3ZlcnJpZGVzICRuZWFyXG4gICAgaWYgKHRoaXMuX3NvcnRTcGVjUGFydHMubGVuZ3RoIHx8ICFvcHRpb25zIHx8ICFvcHRpb25zLmRpc3RhbmNlcykge1xuICAgICAgcmV0dXJuIHRoaXMuX2dldEJhc2VDb21wYXJhdG9yKCk7XG4gICAgfVxuXG4gICAgY29uc3QgZGlzdGFuY2VzID0gb3B0aW9ucy5kaXN0YW5jZXM7XG5cbiAgICAvLyBSZXR1cm4gYSBjb21wYXJhdG9yIHdoaWNoIGNvbXBhcmVzIHVzaW5nICRuZWFyIGRpc3RhbmNlcy5cbiAgICByZXR1cm4gKGEsIGIpID0+IHtcbiAgICAgIGlmICghZGlzdGFuY2VzLmhhcyhhLl9pZCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYE1pc3NpbmcgZGlzdGFuY2UgZm9yICR7YS5faWR9YCk7XG4gICAgICB9XG5cbiAgICAgIGlmICghZGlzdGFuY2VzLmhhcyhiLl9pZCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYE1pc3NpbmcgZGlzdGFuY2UgZm9yICR7Yi5faWR9YCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBkaXN0YW5jZXMuZ2V0KGEuX2lkKSAtIGRpc3RhbmNlcy5nZXQoYi5faWQpO1xuICAgIH07XG4gIH1cblxuICAvLyBUYWtlcyBpbiB0d28ga2V5czogYXJyYXlzIHdob3NlIGxlbmd0aHMgbWF0Y2ggdGhlIG51bWJlciBvZiBzcGVjXG4gIC8vIHBhcnRzLiBSZXR1cm5zIG5lZ2F0aXZlLCAwLCBvciBwb3NpdGl2ZSBiYXNlZCBvbiB1c2luZyB0aGUgc29ydCBzcGVjIHRvXG4gIC8vIGNvbXBhcmUgZmllbGRzLlxuICBfY29tcGFyZUtleXMoa2V5MSwga2V5Mikge1xuICAgIGlmIChrZXkxLmxlbmd0aCAhPT0gdGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGggfHxcbiAgICAgICAga2V5Mi5sZW5ndGggIT09IHRoaXMuX3NvcnRTcGVjUGFydHMubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBFcnJvcignS2V5IGhhcyB3cm9uZyBsZW5ndGgnKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fa2V5Q29tcGFyYXRvcihrZXkxLCBrZXkyKTtcbiAgfVxuXG4gIC8vIEl0ZXJhdGVzIG92ZXIgZWFjaCBwb3NzaWJsZSBcImtleVwiIGZyb20gZG9jIChpZSwgb3ZlciBlYWNoIGJyYW5jaCksIGNhbGxpbmdcbiAgLy8gJ2NiJyB3aXRoIHRoZSBrZXkuXG4gIF9nZW5lcmF0ZUtleXNGcm9tRG9jKGRvYywgY2IpIHtcbiAgICBpZiAodGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignY2FuXFwndCBnZW5lcmF0ZSBrZXlzIHdpdGhvdXQgYSBzcGVjJyk7XG4gICAgfVxuXG4gICAgY29uc3QgcGF0aEZyb21JbmRpY2VzID0gaW5kaWNlcyA9PiBgJHtpbmRpY2VzLmpvaW4oJywnKX0sYDtcblxuICAgIGxldCBrbm93blBhdGhzID0gbnVsbDtcblxuICAgIC8vIG1hcHMgaW5kZXggLT4gKHsnJyAtPiB2YWx1ZX0gb3Ige3BhdGggLT4gdmFsdWV9KVxuICAgIGNvbnN0IHZhbHVlc0J5SW5kZXhBbmRQYXRoID0gdGhpcy5fc29ydFNwZWNQYXJ0cy5tYXAoc3BlYyA9PiB7XG4gICAgICAvLyBFeHBhbmQgYW55IGxlYWYgYXJyYXlzIHRoYXQgd2UgZmluZCwgYW5kIGlnbm9yZSB0aG9zZSBhcnJheXNcbiAgICAgIC8vIHRoZW1zZWx2ZXMuICAoV2UgbmV2ZXIgc29ydCBiYXNlZCBvbiBhbiBhcnJheSBpdHNlbGYuKVxuICAgICAgbGV0IGJyYW5jaGVzID0gZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyhzcGVjLmxvb2t1cChkb2MpLCB0cnVlKTtcblxuICAgICAgLy8gSWYgdGhlcmUgYXJlIG5vIHZhbHVlcyBmb3IgYSBrZXkgKGVnLCBrZXkgZ29lcyB0byBhbiBlbXB0eSBhcnJheSksXG4gICAgICAvLyBwcmV0ZW5kIHdlIGZvdW5kIG9uZSB1bmRlZmluZWQgdmFsdWUuXG4gICAgICBpZiAoIWJyYW5jaGVzLmxlbmd0aCkge1xuICAgICAgICBicmFuY2hlcyA9IFt7IHZhbHVlOiB2b2lkIDAgfV07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVsZW1lbnQgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgICAgbGV0IHVzZWRQYXRocyA9IGZhbHNlO1xuXG4gICAgICBicmFuY2hlcy5mb3JFYWNoKGJyYW5jaCA9PiB7XG4gICAgICAgIGlmICghYnJhbmNoLmFycmF5SW5kaWNlcykge1xuICAgICAgICAgIC8vIElmIHRoZXJlIGFyZSBubyBhcnJheSBpbmRpY2VzIGZvciBhIGJyYW5jaCwgdGhlbiBpdCBtdXN0IGJlIHRoZVxuICAgICAgICAgIC8vIG9ubHkgYnJhbmNoLCBiZWNhdXNlIHRoZSBvbmx5IHRoaW5nIHRoYXQgcHJvZHVjZXMgbXVsdGlwbGUgYnJhbmNoZXNcbiAgICAgICAgICAvLyBpcyB0aGUgdXNlIG9mIGFycmF5cy5cbiAgICAgICAgICBpZiAoYnJhbmNoZXMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ211bHRpcGxlIGJyYW5jaGVzIGJ1dCBubyBhcnJheSB1c2VkPycpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGVsZW1lbnRbJyddID0gYnJhbmNoLnZhbHVlO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHVzZWRQYXRocyA9IHRydWU7XG5cbiAgICAgICAgY29uc3QgcGF0aCA9IHBhdGhGcm9tSW5kaWNlcyhicmFuY2guYXJyYXlJbmRpY2VzKTtcblxuICAgICAgICBpZiAoaGFzT3duLmNhbGwoZWxlbWVudCwgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihgZHVwbGljYXRlIHBhdGg6ICR7cGF0aH1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGVsZW1lbnRbcGF0aF0gPSBicmFuY2gudmFsdWU7XG5cbiAgICAgICAgLy8gSWYgdHdvIHNvcnQgZmllbGRzIGJvdGggZ28gaW50byBhcnJheXMsIHRoZXkgaGF2ZSB0byBnbyBpbnRvIHRoZVxuICAgICAgICAvLyBleGFjdCBzYW1lIGFycmF5cyBhbmQgd2UgaGF2ZSB0byBmaW5kIHRoZSBzYW1lIHBhdGhzLiAgVGhpcyBpc1xuICAgICAgICAvLyByb3VnaGx5IHRoZSBzYW1lIGNvbmRpdGlvbiB0aGF0IG1ha2VzIE1vbmdvREIgdGhyb3cgdGhpcyBzdHJhbmdlXG4gICAgICAgIC8vIGVycm9yIG1lc3NhZ2UuICBlZywgdGhlIG1haW4gdGhpbmcgaXMgdGhhdCBpZiBzb3J0IHNwZWMgaXMge2E6IDEsXG4gICAgICAgIC8vIGI6MX0gdGhlbiBhIGFuZCBiIGNhbm5vdCBib3RoIGJlIGFycmF5cy5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gKEluIE1vbmdvREIgaXQgc2VlbXMgdG8gYmUgT0sgdG8gaGF2ZSB7YTogMSwgJ2EueC55JzogMX0gd2hlcmUgJ2EnXG4gICAgICAgIC8vIGFuZCAnYS54LnknIGFyZSBib3RoIGFycmF5cywgYnV0IHdlIGRvbid0IGFsbG93IHRoaXMgZm9yIG5vdy5cbiAgICAgICAgLy8gI05lc3RlZEFycmF5U29ydFxuICAgICAgICAvLyBYWFggYWNoaWV2ZSBmdWxsIGNvbXBhdGliaWxpdHkgaGVyZVxuICAgICAgICBpZiAoa25vd25QYXRocyAmJiAhaGFzT3duLmNhbGwoa25vd25QYXRocywgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IGluZGV4IHBhcmFsbGVsIGFycmF5cycpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgaWYgKGtub3duUGF0aHMpIHtcbiAgICAgICAgLy8gU2ltaWxhcmx5IHRvIGFib3ZlLCBwYXRocyBtdXN0IG1hdGNoIGV2ZXJ5d2hlcmUsIHVubGVzcyB0aGlzIGlzIGFcbiAgICAgICAgLy8gbm9uLWFycmF5IGZpZWxkLlxuICAgICAgICBpZiAoIWhhc093bi5jYWxsKGVsZW1lbnQsICcnKSAmJlxuICAgICAgICAgICAgT2JqZWN0LmtleXMoa25vd25QYXRocykubGVuZ3RoICE9PSBPYmplY3Qua2V5cyhlbGVtZW50KS5sZW5ndGgpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IGluZGV4IHBhcmFsbGVsIGFycmF5cyEnKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh1c2VkUGF0aHMpIHtcbiAgICAgICAga25vd25QYXRocyA9IHt9O1xuXG4gICAgICAgIE9iamVjdC5rZXlzKGVsZW1lbnQpLmZvckVhY2gocGF0aCA9PiB7XG4gICAgICAgICAga25vd25QYXRoc1twYXRoXSA9IHRydWU7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gZWxlbWVudDtcbiAgICB9KTtcblxuICAgIGlmICgha25vd25QYXRocykge1xuICAgICAgLy8gRWFzeSBjYXNlOiBubyB1c2Ugb2YgYXJyYXlzLlxuICAgICAgY29uc3Qgc29sZUtleSA9IHZhbHVlc0J5SW5kZXhBbmRQYXRoLm1hcCh2YWx1ZXMgPT4ge1xuICAgICAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlcywgJycpKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoJ25vIHZhbHVlIGluIHNvbGUga2V5IGNhc2U/Jyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWVzWycnXTtcbiAgICAgIH0pO1xuXG4gICAgICBjYihzb2xlS2V5KTtcblxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIE9iamVjdC5rZXlzKGtub3duUGF0aHMpLmZvckVhY2gocGF0aCA9PiB7XG4gICAgICBjb25zdCBrZXkgPSB2YWx1ZXNCeUluZGV4QW5kUGF0aC5tYXAodmFsdWVzID0+IHtcbiAgICAgICAgaWYgKGhhc093bi5jYWxsKHZhbHVlcywgJycpKSB7XG4gICAgICAgICAgcmV0dXJuIHZhbHVlc1snJ107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlcywgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignbWlzc2luZyBwYXRoPycpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlc1twYXRoXTtcbiAgICAgIH0pO1xuXG4gICAgICBjYihrZXkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIGNvbXBhcmF0b3IgdGhhdCByZXByZXNlbnRzIHRoZSBzb3J0IHNwZWNpZmljYXRpb24gKGJ1dCBub3RcbiAgLy8gaW5jbHVkaW5nIGEgcG9zc2libGUgZ2VvcXVlcnkgZGlzdGFuY2UgdGllLWJyZWFrZXIpLlxuICBfZ2V0QmFzZUNvbXBhcmF0b3IoKSB7XG4gICAgaWYgKHRoaXMuX3NvcnRGdW5jdGlvbikge1xuICAgICAgcmV0dXJuIHRoaXMuX3NvcnRGdW5jdGlvbjtcbiAgICB9XG5cbiAgICAvLyBJZiB3ZSdyZSBvbmx5IHNvcnRpbmcgb24gZ2VvcXVlcnkgZGlzdGFuY2UgYW5kIG5vIHNwZWNzLCBqdXN0IHNheVxuICAgIC8vIGV2ZXJ5dGhpbmcgaXMgZXF1YWwuXG4gICAgaWYgKCF0aGlzLl9zb3J0U3BlY1BhcnRzLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIChkb2MxLCBkb2MyKSA9PiAwO1xuICAgIH1cblxuICAgIHJldHVybiAoZG9jMSwgZG9jMikgPT4ge1xuICAgICAgY29uc3Qga2V5MSA9IHRoaXMuX2dldE1pbktleUZyb21Eb2MoZG9jMSk7XG4gICAgICBjb25zdCBrZXkyID0gdGhpcy5fZ2V0TWluS2V5RnJvbURvYyhkb2MyKTtcbiAgICAgIHJldHVybiB0aGlzLl9jb21wYXJlS2V5cyhrZXkxLCBrZXkyKTtcbiAgICB9O1xuICB9XG5cbiAgLy8gRmluZHMgdGhlIG1pbmltdW0ga2V5IGZyb20gdGhlIGRvYywgYWNjb3JkaW5nIHRvIHRoZSBzb3J0IHNwZWNzLiAgKFdlIHNheVxuICAvLyBcIm1pbmltdW1cIiBoZXJlIGJ1dCB0aGlzIGlzIHdpdGggcmVzcGVjdCB0byB0aGUgc29ydCBzcGVjLCBzbyBcImRlc2NlbmRpbmdcIlxuICAvLyBzb3J0IGZpZWxkcyBtZWFuIHdlJ3JlIGZpbmRpbmcgdGhlIG1heCBmb3IgdGhhdCBmaWVsZC4pXG4gIC8vXG4gIC8vIE5vdGUgdGhhdCB0aGlzIGlzIE5PVCBcImZpbmQgdGhlIG1pbmltdW0gdmFsdWUgb2YgdGhlIGZpcnN0IGZpZWxkLCB0aGVcbiAgLy8gbWluaW11bSB2YWx1ZSBvZiB0aGUgc2Vjb25kIGZpZWxkLCBldGNcIi4uLiBpdCdzIFwiY2hvb3NlIHRoZVxuICAvLyBsZXhpY29ncmFwaGljYWxseSBtaW5pbXVtIHZhbHVlIG9mIHRoZSBrZXkgdmVjdG9yLCBhbGxvd2luZyBvbmx5IGtleXMgd2hpY2hcbiAgLy8geW91IGNhbiBmaW5kIGFsb25nIHRoZSBzYW1lIHBhdGhzXCIuICBpZSwgZm9yIGEgZG9jIHthOiBbe3g6IDAsIHk6IDV9LCB7eDpcbiAgLy8gMSwgeTogM31dfSB3aXRoIHNvcnQgc3BlYyB7J2EueCc6IDEsICdhLnknOiAxfSwgdGhlIG9ubHkga2V5cyBhcmUgWzAsNV0gYW5kXG4gIC8vIFsxLDNdLCBhbmQgdGhlIG1pbmltdW0ga2V5IGlzIFswLDVdOyBub3RhYmx5LCBbMCwzXSBpcyBOT1QgYSBrZXkuXG4gIF9nZXRNaW5LZXlGcm9tRG9jKGRvYykge1xuICAgIGxldCBtaW5LZXkgPSBudWxsO1xuXG4gICAgdGhpcy5fZ2VuZXJhdGVLZXlzRnJvbURvYyhkb2MsIGtleSA9PiB7XG4gICAgICBpZiAobWluS2V5ID09PSBudWxsKSB7XG4gICAgICAgIG1pbktleSA9IGtleTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5fY29tcGFyZUtleXMoa2V5LCBtaW5LZXkpIDwgMCkge1xuICAgICAgICBtaW5LZXkgPSBrZXk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gbWluS2V5O1xuICB9XG5cbiAgX2dldFBhdGhzKCkge1xuICAgIHJldHVybiB0aGlzLl9zb3J0U3BlY1BhcnRzLm1hcChwYXJ0ID0+IHBhcnQucGF0aCk7XG4gIH1cblxuICAvLyBHaXZlbiBhbiBpbmRleCAnaScsIHJldHVybnMgYSBjb21wYXJhdG9yIHRoYXQgY29tcGFyZXMgdHdvIGtleSBhcnJheXMgYmFzZWRcbiAgLy8gb24gZmllbGQgJ2knLlxuICBfa2V5RmllbGRDb21wYXJhdG9yKGkpIHtcbiAgICBjb25zdCBpbnZlcnQgPSAhdGhpcy5fc29ydFNwZWNQYXJ0c1tpXS5hc2NlbmRpbmc7XG5cbiAgICByZXR1cm4gKGtleTEsIGtleTIpID0+IHtcbiAgICAgIGNvbnN0IGNvbXBhcmUgPSBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcChrZXkxW2ldLCBrZXkyW2ldKTtcbiAgICAgIHJldHVybiBpbnZlcnQgPyAtY29tcGFyZSA6IGNvbXBhcmU7XG4gICAgfTtcbiAgfVxufVxuXG4vLyBHaXZlbiBhbiBhcnJheSBvZiBjb21wYXJhdG9yc1xuLy8gKGZ1bmN0aW9ucyAoYSxiKS0+KG5lZ2F0aXZlIG9yIHBvc2l0aXZlIG9yIHplcm8pKSwgcmV0dXJucyBhIHNpbmdsZVxuLy8gY29tcGFyYXRvciB3aGljaCB1c2VzIGVhY2ggY29tcGFyYXRvciBpbiBvcmRlciBhbmQgcmV0dXJucyB0aGUgZmlyc3Rcbi8vIG5vbi16ZXJvIHZhbHVlLlxuZnVuY3Rpb24gY29tcG9zZUNvbXBhcmF0b3JzKGNvbXBhcmF0b3JBcnJheSkge1xuICByZXR1cm4gKGEsIGIpID0+IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvbXBhcmF0b3JBcnJheS5sZW5ndGg7ICsraSkge1xuICAgICAgY29uc3QgY29tcGFyZSA9IGNvbXBhcmF0b3JBcnJheVtpXShhLCBiKTtcbiAgICAgIGlmIChjb21wYXJlICE9PSAwKSB7XG4gICAgICAgIHJldHVybiBjb21wYXJlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiAwO1xuICB9O1xufVxuIl19
