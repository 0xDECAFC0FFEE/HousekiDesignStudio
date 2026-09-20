/*
 * gemcad.js -- a JavaScript port of LibGemcadFileReader: a reader for GemCad
 * .ASC (text) and .GEM (binary) faceting-design files.
 *
 * Ported from the C# library "GemCAD File Reader".
 *   Original author: Mathew Parker
 *   Upstream:        https://github.com/mbparker/gemcad-file-reader
 *   Copyright (c)    2023 Mathew Parker
 *   Licence:         MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---------------------------------------------------------------------------
 * Porting notes (this file deliberately mirrors the C# behaviour, quirks and
 * all; see the comments marked PORT for the places where C# and JS semantics
 * differ and the port has to work to keep them the same):
 *
 *   - The original reads files from disk.  A browser cannot, and this project
 *     inlines everything into one file:// page, so the entry points here take
 *     bytes or text that the caller has already obtained.
 *   - This is a classic script, not an ES module: no import/export, and the
 *     public surface is published as globalThis.GemCad at the bottom.
 * ---------------------------------------------------------------------------
 */

(function () {
    "use strict";

    // =======================================================================
    // Constants (LibGemcadFileReader/Constants.cs)
    // =======================================================================

    var RADIAN = Math.PI / 180.0;
    var TOLERANCE = 0.0000000001;

    // PORT TRAP 1: C#'s `double.Epsilon` is the smallest positive subnormal
    // double (~4.94e-324), NOT machine epsilon.  Every `Math.Abs(x) >=
    // double.Epsilon` in the original is therefore just "x is not zero", and
    // every `Math.Abs(x) < double.Epsilon` is "x is zero".  JavaScript's exact
    // equivalent is Number.MIN_VALUE (5e-324).  Using Number.EPSILON
    // (2.220446e-16) here would silently change the library's behaviour, so it
    // is not used anywhere in this file.
    var DOUBLE_EPSILON = Number.MIN_VALUE;

    // =======================================================================
    // Numeric helpers that exist only to reproduce .NET semantics
    // =======================================================================

    /**
     * Round to the nearest integer, ties to even -- what C# `Math.Round(double)`
     * and `Convert.ToInt32(double)` do ("banker's rounding").
     *
     * PORT TRAP 2: JavaScript's Math.round() rounds halves *up* (towards
     * +Infinity), so Math.round(2.5) === 3 and Math.round(-2.5) === -2, while
     * C# gives 2 and -2.  Any place the original rounds must come through here.
     */
    function roundHalfToEvenInteger(value) {
        if (!isFinite(value)) {
            return value;
        }
        var floor = Math.floor(value);
        var diff = value - floor;
        if (diff > 0.5) {
            return floor + 1;
        }
        if (diff < 0.5) {
            return floor;
        }
        // Exactly halfway: pick whichever neighbour is even.  `floor % 2` is 0
        // for even floors including negative ones (-4 % 2 === -0), so the test
        // works on both sides of zero.
        return (floor % 2 === 0) ? floor : floor + 1;
    }

    /**
     * C# `Math.Round(double value, int digits)` -- scale by 10^digits, round
     * half-to-even, scale back.  .NET leaves very large values alone (its
     * internal `doubleRoundLimit` is 1e16); that guard is mirrored so the two
     * implementations agree everywhere, not just on small inputs.
     */
    function roundHalfToEven(value, digits) {
        if (!isFinite(value)) {
            return value;
        }
        if (Math.abs(value) >= 1e16) {
            return value;
        }
        var power10 = Math.pow(10, digits);
        return roundHalfToEvenInteger(value * power10) / power10;
    }

    /**
     * C# `Convert.ToInt32(double)`: rounds half-to-even and throws if the
     * result will not fit in a 32-bit signed integer.
     */
    function convertToInt32(value) {
        var rounded = roundHalfToEvenInteger(value);
        if (!isFinite(rounded) || rounded < -2147483648 || rounded > 2147483647) {
            throw new RangeError("Value was either too large or too small for an Int32.");
        }
        return rounded;
    }

    /**
     * C# `double.TryParse` with the invariant culture.
     *
     * PORT TRAP 3: this must be a *strict, whole-string* parse.  JavaScript's
     * parseFloat("96 n 1") happily returns 96, but the .asc `a`-line parser
     * relies on TryParse *failing* to detect where the facet-index list ends
     * and the free-text cutting instructions begin.  A lenient parse would
     * swallow the instructions as indices.
     *
     * Returns the number, or null when the original would have returned false.
     * (.NET would also accept group separators such as "1,234"; no GemCad file
     * contains those, and accepting them would make "1,234" parse as a facet
     * index, so they are rejected here.)
     */
    function tryParseFloat(text) {
        if (typeof text !== "string") {
            return null;
        }
        var trimmed = text.trim();
        if (trimmed.length === 0) {
            return null;
        }
        if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
            return null;
        }
        var value = Number(trimmed);
        return isFinite(value) ? value : null;
    }

    /**
     * C# `int.TryParse` with NumberStyles.Integer: optional surrounding
     * whitespace, optional sign, digits only, and it must fit in an Int32.
     * Returns the number or null.
     */
    function tryParseInt(text) {
        if (typeof text !== "string") {
            return null;
        }
        var trimmed = text.trim();
        if (!/^[+-]?\d+$/.test(trimmed)) {
            return null;
        }
        var value = Number(trimmed);
        if (!isFinite(value) || value < -2147483648 || value > 2147483647) {
            return null;
        }
        return value;
    }

    /** C# `string.IsNullOrWhiteSpace`. */
    function isNullOrWhiteSpace(text) {
        return text === null || text === undefined || text.trim().length === 0;
    }

    /**
     * C# `Encoding.ASCII.GetString`.
     *
     * PORT TRAP 6: this is *not* Latin-1 and not UTF-8.  .NET's ASCII encoding
     * replaces every byte with the high bit set by '?' (0x3F).  A naive
     * String.fromCharCode() would produce Latin-1 characters instead and the
     * strings would differ from the reference for any non-ASCII byte.
     */
    function asciiGetString(bytes) {
        var out = "";
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i];
            out += String.fromCharCode(b >= 0x80 ? 0x3f : b);
        }
        return out;
    }

    /** C#'s `value.ToString("F4")`, used only to build vertex-dictionary keys. */
    function toFixed4(value) {
        return value.toFixed(4);
    }

    // =======================================================================
    // MathUtils.cs
    // =======================================================================

    var MathUtils = {
        filterAngle: function (angle) {
            return MathUtils.clockN(angle, 360.0);
        },

        clockN: function (value, basis) {
            basis = Math.abs(basis);
            var result = value;
            while (result > basis) {
                result -= basis;
            }
            while (result < -basis) {
                result += basis;
            }
            if (Math.abs(result) < 0.00000001) {
                result = 0;
            }
            return result;
        }
    };

    // =======================================================================
    // Models/Geometry/Primitive/*.cs
    //
    // PORT TRAP 4 (copy-on-assign).  In the C# originals `PolygonVertex.Vertex`,
    // `PolygonVertex.Normal` and `Polygon.Normal` are properties whose setters
    // call `Assign(value)`, which copies the *field values* into the existing
    // instance rather than rebinding a reference.  `Triangle.P1 = v` likewise
    // calls `Vertices[0].Assign(v)`.  A JS port that simply stored the object
    // handed in would alias geometry between polygons and corrupt it as soon as
    // one of them was mutated (and the cutting code mutates constantly).  The
    // accessors below reproduce the copy semantics exactly.
    // =======================================================================

    function Vertex3D(x, y, z) {
        this.x = x === undefined ? 0 : x;
        this.y = y === undefined ? 0 : y;
        this.z = z === undefined ? 0 : z;
    }

    Vertex3D.prototype.clone = function () {
        return new Vertex3D(this.x, this.y, this.z);
    };

    Vertex3D.prototype.assign = function (source) {
        if (source instanceof Vertex3D) {
            this.x = source.x;
            this.y = source.y;
            this.z = source.z;
            return;
        }
        throw new TypeError("Cannot assign the given value to a Vertex3D");
    };

    Vertex3D.prototype.toString = function () {
        return this.x + ";" + this.y + ";" + this.z;
    };

    Vertex3D.prototype.toSortString = function () {
        return toFixed4(this.x) + "," + toFixed4(this.y) + "," + toFixed4(this.z);
    };

    function PolygonVertex(point) {
        this._normal = new Vertex3D();
        this._vertex = new Vertex3D();
        if (point !== undefined && point !== null) {
            this.vertex = point; // copies, via the setter below
        }
    }

    Object.defineProperties(PolygonVertex.prototype, {
        normal: {
            get: function () { return this._normal; },
            set: function (value) { this._normal.assign(value); }
        },
        vertex: {
            get: function () { return this._vertex; },
            set: function (value) { this._vertex.assign(value); }
        }
    });

    PolygonVertex.prototype.assign = function (source) {
        if (source instanceof PolygonVertex) {
            this.vertex = source.vertex;
            this.normal = source.normal;
        }
    };

    function Polygon(vertexCount) {
        this._normal = new Vertex3D();
        this._vertices = [];
        this.tag = "{}";
        var count = vertexCount === undefined ? 0 : vertexCount;
        for (var i = 0; i < count; i++) {
            this._vertices.push(new PolygonVertex());
        }
    }

    Object.defineProperties(Polygon.prototype, {
        normal: {
            get: function () { return this._normal; },
            set: function (value) { this._normal.assign(value); }
        },
        vertices: {
            get: function () { return this._vertices; }
        },
        // `protected virtual bool PointCountImmutable => false;`
        pointCountImmutable: {
            get: function () { return false; }
        }
    });

    Polygon.prototype.replace = function (newVertices) {
        if (this._vertices.length !== newVertices.length) {
            this._throwIfPointCountImmutable();
        }
        this._vertices.length = 0;
        for (var i = 0; i < newVertices.length; i++) {
            this._vertices.push(newVertices[i]);
        }
    };

    Polygon.prototype.removeAt = function (index) {
        this._throwIfPointCountImmutable();
        this._vertices.splice(index, 1);
    };

    Polygon.prototype.add = function (newVertex) {
        this._throwIfPointCountImmutable();
        this._vertices.push(newVertex);
    };

    Polygon.prototype.reverse = function () {
        this._vertices.reverse();
    };

    Polygon.prototype._throwIfPointCountImmutable = function () {
        if (this.pointCountImmutable) {
            throw new Error("The number of points cannot change in a polygon of this type");
        }
    };

    function Triangle() {
        Polygon.call(this, 3);
    }
    Triangle.prototype = Object.create(Polygon.prototype);
    Triangle.prototype.constructor = Triangle;

    function definePolygonPointAccessors(ctor, names) {
        names.forEach(function (name, slot) {
            Object.defineProperty(ctor.prototype, name, {
                get: function () { return this._vertices[slot]; },
                // Copy-on-assign, exactly like `Vertices[slot].Assign(value)`.
                set: function (value) { this._vertices[slot].assign(value); }
            });
        });
        Object.defineProperty(ctor.prototype, "pointCountImmutable", {
            get: function () { return true; }
        });
    }

    definePolygonPointAccessors(Triangle, ["p1", "p2", "p3"]);

    function Quad() {
        Polygon.call(this, 4);
    }
    Quad.prototype = Object.create(Polygon.prototype);
    Quad.prototype.constructor = Quad;
    definePolygonPointAccessors(Quad, ["p1", "p2", "p3", "p4"]);

    // =======================================================================
    // Models/Geometry/*.cs -- plain data carriers
    // =======================================================================

    function GemCadFileMetadata() {
        this.gear = 0;
        this.gearLocationAngle = 0;
        this.refractiveIndex = 0;
        this.symmetryFolds = 0;
        this.symmetryMirror = false;
        this.headers = [];
        this.footnotes = [];
    }

    function GemCadFileTierIndexData() {
        this.tier = 0;
        this.name = "";
        this.index = NaN; // `double.NaN` until a tier definition fills it in
        this.facetNormal = new Vertex3D();
        this.points = [];
        this.renderingTriangles = [];
    }

    function GemCadFileTierData() {
        this.isPreform = false;
        this.number = 0;
        this.angle = 0;
        this.distance = 0;
        this.cuttingInstructions = null; // C# `string` default is null
        this.indices = [];
    }

    function GemCadFileData() {
        this.metadata = new GemCadFileMetadata();
        this.tiers = [];
    }

    // =======================================================================
    // Concrete/VectorOperations.cs
    // =======================================================================

    var VectorOperations = {
        add: function (p1, p2) {
            return new Vertex3D(p1.x + p2.x, p1.y + p2.y, p1.z + p2.z);
        },

        subtract: function (p1, p2) {
            return new Vertex3D(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
        },

        crossProduct: function (p1, p2) {
            return new Vertex3D(
                (p1.y * p2.z) - (p1.z * p2.y),
                (p1.z * p2.x) - (p1.x * p2.z),
                (p1.x * p2.y) - (p1.y * p2.x)
            );
        },

        dotProduct: function (p1, p2) {
            return p1.x * p2.x + p1.y * p2.y + p1.z * p2.z;
        },

        divide: function (p, quo) {
            return new Vertex3D(p.x / quo, p.y / quo, p.z / quo);
        },

        multiplyScalar: function (p, f) {
            return new Vertex3D(p.x * f, p.y * f, p.z * f);
        },

        /** Normalises IN PLACE and returns nothing, like the original. */
        normalize: function (p) {
            var length = Math.sqrt((p.x * p.x) + (p.y * p.y) + (p.z * p.z));
            if (length > 0) {
                p.x = p.x / length;
                p.y = p.y / length;
                p.z = p.z / length;
            }
        },

        length: function (p) {
            return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        },

        negative: function (p) {
            return new Vertex3D(-p.x, -p.y, -p.z);
        },

        calculateNormal: function (p1, p2, p3) {
            var v1 = VectorOperations.subtract(p1, p2);
            var v2 = VectorOperations.subtract(p2, p3);
            var normal = VectorOperations.crossProduct(v1, v2);
            VectorOperations.normalize(normal);
            return normal;
        },

        /**
         * PORT TRAP 8: the four-point overload in the original is buggy -- the
         * second call passes `p3` twice, so `CalculateNormal(p3, p3, p4)` always
         * returns a zero-length cross product.  It is dead code: neither import
         * path calls it.  It is ported faithfully, bug included, so that this
         * file stays a true mirror of the reference; do not "fix" it, because
         * then the port would no longer match what upstream computes.
         */
        calculateNormal4: function (p1, p2, p3, p4) {
            var n1 = VectorOperations.calculateNormal(p1, p2, p4);
            var n2 = VectorOperations.calculateNormal(p3, p3, p4); // sic -- upstream bug
            return VectorOperations.add(n1, n2);
        },

        /**
         * NOTE: this mutates (normalises) both arguments, exactly as the C#
         * does.  Callers that care pass clones.
         */
        angleBetween: function (p1, p2) {
            VectorOperations.normalize(p1);
            VectorOperations.normalize(p2);
            return (VectorOperations.dotProduct(p1, p2) >= 0.0
                ? 2.0 * Math.asin(VectorOperations.length(VectorOperations.subtract(p1, p2)) / 2.0)
                : Math.PI - 2.0 * Math.asin(
                    VectorOperations.length(
                        VectorOperations.subtract(VectorOperations.negative(p1), p2)) / 2.0)
            ) * (180.0 / Math.PI);
        },

        /**
         * PORT TRAP 9: this is NOT the textbook ray-plane intersection.  A
         * textbook version would return `rayOrigin + rayDirection * t`; this
         * returns `(rayOrigin - rayDirection) * t`.  It is nevertheless what
         * GemCadGemImport uses to recover each tier's distance from the origin,
         * and with the origin as rayOrigin and the facet normal as direction it
         * gives the right answer for that case.  Ported verbatim on purpose.
         */
        findRayPlaneIntersection: function (rayOrigin, rayDirection, plane) {
            var diff = VectorOperations.subtract(rayOrigin, plane.p1.vertex);
            var prod1 = VectorOperations.dotProduct(diff, plane.normal);
            var prod2 = VectorOperations.dotProduct(rayDirection, plane.normal);
            var prod3 = prod1 / prod2;
            return VectorOperations.multiplyScalar(
                VectorOperations.subtract(rayOrigin, rayDirection), prod3);
        }
    };

    // =======================================================================
    // Concrete/GeometryOperations.cs
    // =======================================================================

    var GeometryOperations = {
        length3d: function (p1, p2) {
            var x = Math.pow(p2.x - p1.x, 2);
            var y = Math.pow(p2.y - p1.y, 2);
            var z = Math.pow(p2.z - p1.z, 2);
            return Math.sqrt(x + y + z);
        },

        projectPoint: function (center, distance, angle) {
            var radians = angle * RADIAN;
            var moveX = Math.cos(radians) * distance;
            var moveY = Math.sin(radians) * distance;
            return new Vertex3D(moveX + center.x, moveY + center.y, center.z);
        },

        rotatePoint: function (point, yaw, roll, pitch, center) {
            var result = new Vertex3D(point.x, point.y, point.z);
            // `>= double.Epsilon` means "is not zero" -- see DOUBLE_EPSILON above.
            if (Math.abs(yaw) >= DOUBLE_EPSILON ||
                Math.abs(roll) >= DOUBLE_EPSILON ||
                Math.abs(pitch) >= DOUBLE_EPSILON) {
                yaw = MathUtils.filterAngle(yaw);
                roll = MathUtils.filterAngle(roll);
                pitch = MathUtils.filterAngle(pitch);

                result.x -= center.x;
                result.y -= center.y;
                result.z -= center.z;

                var yawCosine = Math.cos(yaw * RADIAN);
                var yawSine = Math.sin(yaw * RADIAN);
                var rollCosine = Math.cos(roll * RADIAN);
                var rollSine = Math.sin(roll * RADIAN);
                var pitchCosine = Math.cos(pitch * RADIAN);
                var pitchSine = Math.sin(pitch * RADIAN);

                // The assignment order matters: result.x is overwritten before
                // workY is computed, but workY reads result.y, which is still
                // the incoming value at that point.  Kept verbatim.
                var workX = (yawCosine * result.x) - (yawSine * result.z);
                var workZ = (yawSine * result.x) + (yawCosine * result.z);
                result.x = (rollCosine * workX) + (rollSine * result.y);
                var workY = (rollCosine * result.y) - (rollSine * workX);
                result.z = (pitchCosine * workZ) - (pitchSine * workY);
                result.y = (pitchSine * workZ) + (pitchCosine * workY);

                result.x += center.x;
                result.y += center.y;
                result.z += center.z;
            }
            return result;
        },

        getAngle2d: function (p1, p2) {
            var vp1 = new Vertex3D(p2.x - p1.x, p2.y - p1.y, 0);
            var vp2 = new Vertex3D();
            var vp3 = new Vertex3D(25, 0, 0);

            var angle = GeometryOperations.angleBetweenConnectedVectors(vp1, vp2, vp3);

            if (vp1.y < 0) {
                return -(180 - angle);
            }

            return 180 - angle;
        },

        angleBetweenConnectedVectors: function (p1, p2, p3) {
            var tb3 = 0;
            var a = GeometryOperations.length3d(p1, p2);
            var b = GeometryOperations.length3d(p2, p3);
            var dc = a * b;
            if (Math.abs(dc) < DOUBLE_EPSILON) { // i.e. dc === 0
                return -1;
            }
            var nc = (p2.x - p1.x) * (p3.x - p2.x);
            nc += (p2.y - p1.y) * (p3.y - p2.y);
            nc += (p2.z - p1.z) * (p3.z - p2.z);
            var ic = nc / dc;

            if ((ic <= -1) || (ic >= 1)) {
                if (ic <= -1) {
                    tb3 = 180;
                }
                if (ic >= 1) {
                    tb3 = 0;
                }
            } else {
                a = Math.sqrt((-ic * ic) + 1);
                if (Math.abs(a) < DOUBLE_EPSILON) { // i.e. a === 0
                    return -1;
                }
                tb3 = 90 - ((1 / (Math.PI / 180)) * (Math.atan(ic / a)));
            }

            return Math.abs(tb3);
        },

        projectPointAlongVector: function (p1, p2, distance) {
            var result = new Vertex3D(p1.x, p1.y, p1.z);
            if (Math.abs(distance) >= DOUBLE_EPSILON) { // i.e. distance !== 0
                var x = p1.x - p2.x;
                var y = p1.y - p2.y;
                var z = p1.z - p2.z;
                var q = Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2) + Math.pow(z, 2)) - distance;
                var denom = distance + q;

                if (Math.abs(denom) >= DOUBLE_EPSILON) { // i.e. denom !== 0
                    result.x = (q * p1.x + distance * p2.x) / denom;
                    result.y = (q * p1.y + distance * p2.y) / denom;
                    result.z = (q * p1.z + distance * p2.z) / denom;
                }
            }

            return result;
        },

        createTriangleFromPoints: function (p1, p2, p3, ensureWindingOrder) {
            var triangle = new Triangle();
            triangle.p1 = new PolygonVertex(p1);
            triangle.p2 = new PolygonVertex(p2);
            triangle.p3 = new PolygonVertex(p3);

            if (ensureWindingOrder) {
                // Don't assume the winding is correct, because it's probably not
                // for half the polys.  Check both directions, and take the
                // normal with the end furthest from 0,0,0.  (Upstream comment.)
                var normal1 = VectorOperations.calculateNormal(
                    triangle.p1.vertex, triangle.p2.vertex, triangle.p3.vertex);
                var normalEnd1 = VectorOperations.add(normal1, triangle.p1.vertex);
                var dist1 = GeometryOperations.length3d(normalEnd1, new Vertex3D());

                var normal2 = VectorOperations.calculateNormal(
                    triangle.p3.vertex, triangle.p2.vertex, triangle.p1.vertex);
                var normalEnd2 = VectorOperations.add(normal2, triangle.p1.vertex);
                var dist2 = GeometryOperations.length3d(normalEnd2, new Vertex3D());

                if (Math.abs(dist2) > Math.abs(dist1)) {
                    triangle.reverse();
                    triangle.normal = normal2;
                } else {
                    triangle.normal = normal1;
                }
            } else {
                triangle.normal = VectorOperations.calculateNormal(
                    triangle.p1.vertex, triangle.p2.vertex, triangle.p3.vertex);
            }

            triangle.p1.normal = triangle.normal;
            triangle.p2.normal = triangle.normal;
            triangle.p3.normal = triangle.normal;

            return triangle;
        }
    };

    // =======================================================================
    // Concrete/PolygonSubdivisionProvider.cs
    // =======================================================================

    function computeFaceNormals(triangles) {
        for (var i = 0; i < triangles.length; i++) {
            var triangle = triangles[i];
            triangle.normal = VectorOperations.calculateNormal(
                triangle.p1.vertex, triangle.p2.vertex, triangle.p3.vertex);
        }
    }

    /**
     * Groups vertices that share a rounded position (the `ToSortString` key) so
     * their normals can be averaged.  A C# Dictionary enumerates in insertion
     * order when nothing is removed, and a JS Map guarantees insertion order,
     * so the two produce the same group ordering.
     */
    function findVertexFaceReferences(triangles) {
        var dict = new Map();
        for (var i = 0; i < triangles.length; i++) {
            var triangle = triangles[i];
            for (var j = 0; j < triangle.vertices.length; j++) {
                var vertex = triangle.vertices[j];
                var key = vertex.vertex.toSortString();
                var item = dict.get(key);
                if (item === undefined) {
                    item = { vertices: [], polygons: [] };
                    dict.set(key, item);
                }
                item.vertices.push(vertex);
                item.polygons.push(triangle);
            }
        }
        return Array.from(dict.values());
    }

    function computeVertexNormals(triangles) {
        var list = findVertexFaceReferences(triangles);
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var normal = new Vertex3D();
            for (var j = 0; j < item.polygons.length; j++) {
                normal = VectorOperations.add(normal, item.polygons[j].normal);
            }
            normal = VectorOperations.divide(normal, item.polygons.length);
            VectorOperations.normalize(normal);
            for (var k = 0; k < item.vertices.length; k++) {
                item.vertices[k].normal = normal; // copies
            }
        }
    }

    /**
     * One-to-four triangle subdivision.
     *
     * PORT TRAP 10: the original builds its output by removing each source
     * triangle from the working list and appending that triangle's 4 children.
     * Walking that through for a list [T0,T1,T2] shows the result is exactly
     * the children in source order -- remove T0 then append its children gives
     * [T1,T2,c0..], remove T1 gives [T2,c0..,c1..], remove T2 gives
     * [c0..,c1..,c2..] -- i.e. identical to a flatMap over the input.  (`Remove`
     * is reference equality here, since Triangle does not override Equals, so
     * it always removes the source triangle and never a look-alike.)  That was
     * verified before relying on it, and the flatMap form is used below.
     *
     * Note that the normals are computed per group of four children, so vertex
     * normals are averaged only inside each subdivided triangle, never across
     * neighbouring ones.  That is upstream behaviour, not an oversight here.
     */
    function subdivideTriangles(triangles, iterations) {
        var result = triangles.slice();
        for (var iteration = 1; iteration <= iterations; iteration++) {
            var source = result;
            result = [];
            for (var t = 0; t < source.length; t++) {
                var triangle = source[t];

                var length1 = GeometryOperations.length3d(triangle.p1.vertex, triangle.p2.vertex);
                var a = GeometryOperations.projectPointAlongVector(
                    triangle.p1.vertex, triangle.p2.vertex, length1 / 2.0);
                var length2 = GeometryOperations.length3d(triangle.p2.vertex, triangle.p3.vertex);
                var b = GeometryOperations.projectPointAlongVector(
                    triangle.p2.vertex, triangle.p3.vertex, length2 / 2.0);
                var length3 = GeometryOperations.length3d(triangle.p3.vertex, triangle.p1.vertex);
                var c = GeometryOperations.projectPointAlongVector(
                    triangle.p3.vertex, triangle.p1.vertex, length3 / 2.0);

                var newTriangles = [];
                var newTriangle;

                newTriangle = new Triangle();
                newTriangle.p1.vertex = triangle.p1.vertex;
                newTriangle.p2.vertex = a;
                newTriangle.p3.vertex = c;
                newTriangles.push(newTriangle);

                newTriangle = new Triangle();
                newTriangle.p1.vertex = a;
                newTriangle.p2.vertex = triangle.p2.vertex;
                newTriangle.p3.vertex = b;
                newTriangles.push(newTriangle);

                newTriangle = new Triangle();
                newTriangle.p1.vertex = c;
                newTriangle.p2.vertex = b;
                newTriangle.p3.vertex = triangle.p3.vertex;
                newTriangles.push(newTriangle);

                newTriangle = new Triangle();
                newTriangle.p1.vertex = a;
                newTriangle.p2.vertex = b;
                newTriangle.p3.vertex = c;
                newTriangles.push(newTriangle);

                computeFaceNormals(newTriangles);
                computeVertexNormals(newTriangles);
                for (var n = 0; n < newTriangles.length; n++) {
                    result.push(newTriangles[n]);
                }
            }
        }
        return result;
    }

    // =======================================================================
    // Shared by both importers
    // =======================================================================

    function convertCoplanarPointsToTriangles(points) {
        var result = [];
        for (var i = 1; i < points.length - 1; i++) {
            result.push(GeometryOperations.createTriangleFromPoints(
                points[0], points[i], points[i + 1], true));
        }
        return result;
    }

    /** `BuildModel` / `ProcessPolygons` -- identical in both importers. */
    function buildRenderingTriangles(data, logger) {
        var startingTriangleCount = 0;
        var endingTriangleCount = 0;
        for (var i = 0; i < data.tiers.length; i++) {
            for (var j = 0; j < data.tiers[i].indices.length; j++) {
                var index = data.tiers[i].indices[j];
                var triangles = convertCoplanarPointsToTriangles(index.points);
                if (triangles.length > 0) {
                    startingTriangleCount += triangles.length;
                    index.renderingTriangles = subdivideTriangles(triangles, 1);
                    endingTriangleCount += index.renderingTriangles.length;
                }
            }
        }
        logger.debug("[GEMIMPORT] Subdivided " + startingTriangleCount + " triangles to " +
            endingTriangleCount + " triangles for rendering.");
    }

    function isSamePoint(pt1, pt2) {
        return Math.abs(GeometryOperations.length3d(pt1, pt2)) < TOLERANCE;
    }

    // =======================================================================
    // Concrete/GemCadAscImport.cs
    // =======================================================================

    /**
     * `ReArrangePoints`: orders a polygon's points around its perimeter by
     * sorting them on the angle each subtends at point 0 against the widest
     * spoke.  Ported verbatim, including the pre-filled slot list -- if two
     * points tie exactly on angle the same slot is written twice and one slot
     * is left as the (0,0,0) placeholder, which is upstream behaviour.
     */
    function reArrangePoints(polygon) {
        if (polygon.vertices.length < 4) {
            return;
        }

        var vertices = polygon.vertices.slice();
        var maxIndex = 0;
        var point1 = vertices[0].vertex;
        var point2, point3, g0, g1, i, j;

        var reorderedPointList = [];
        for (i = 0; i < vertices.length; i++) {
            reorderedPointList.push(new Vertex3D());
        }

        reorderedPointList[0] = point1;

        var maxAngle;
        var dAngles = [0];

        for (i = 1; i < vertices.length; i++) {
            point2 = vertices[i].vertex;
            maxAngle = 0;
            for (j = 1; j < vertices.length; j++) {
                if (i !== j) {
                    point3 = vertices[j].vertex;

                    g0 = new Vertex3D(point2.x - point1.x, point2.y - point1.y, point2.z - point1.z);
                    g1 = new Vertex3D(point3.x - point1.x, point3.y - point1.y, point3.z - point1.z);

                    var angle = angleBetweenClones(g0, g1);
                    if (maxAngle < angle) {
                        maxAngle = angle;
                    }
                }
            }
            dAngles.push(maxAngle);
        }

        maxAngle = 0;
        for (i = 1; i < dAngles.length; i++) {
            if (maxAngle < dAngles[i]) {
                maxAngle = dAngles[i];
                maxIndex = i;
            }
        }

        point2 = vertices[maxIndex].vertex;
        reorderedPointList[1] = point2;
        dAngles.length = 0;
        dAngles.push(-1);

        for (i = 1; i < vertices.length; i++) {
            point3 = vertices[i].vertex;
            g0 = new Vertex3D(point2.x - point1.x, point2.y - point1.y, point2.z - point1.z);
            g1 = new Vertex3D(point3.x - point1.x, point3.y - point1.y, point3.z - point1.z);
            dAngles.push(angleBetweenClones(g0, g1));
        }

        for (i = 1; i < dAngles.length; i++) {
            if (i !== maxIndex) {
                var nLows = 0;
                for (j = 0; j < dAngles.length; j++) {
                    if (dAngles[j] < dAngles[i]) {
                        nLows++;
                    }
                }
                reorderedPointList[nLows] = vertices[i].vertex;
            }
        }

        polygon.replace(reorderedPointList.map(function (v) { return new PolygonVertex(v); }));
    }

    /** The importer's private AngleBetween, which clones so the originals are
     *  not normalised in place by VectorOperations.angleBetween. */
    function angleBetweenClones(p1, p2) {
        return VectorOperations.angleBetween(p1.clone(), p2.clone());
    }

    function generateRoughCube() {
        var L = 10;
        var result = [];

        // Each face is a plain Polygon, not a Quad, because the cutting code
        // has to be able to add and remove its points.
        function face(corners) {
            var quad = new Polygon(4);
            result.push(quad);
            for (var i = 0; i < 4; i++) {
                quad.vertices[corners[i][0]].vertex.x = corners[i][1] * L;
                quad.vertices[corners[i][0]].vertex.y = corners[i][2] * L;
                quad.vertices[corners[i][0]].vertex.z = corners[i][3] * L;
            }
        }

        // The slot indices below reproduce the winding the original writes in
        // AddLeft/AddFront/AddRight/AddBack/AddTop/AddBottom, which fill the
        // four slots in different orders for different faces.
        face([[3, -1, -1, 1], [2, -1, -1, -1], [1, -1, 1, -1], [0, -1, 1, 1]]);   // left
        face([[3, 1, -1, 1], [2, -1, -1, 1], [1, -1, 1, 1], [0, 1, 1, 1]]);       // front
        face([[0, 1, -1, -1], [1, 1, 1, -1], [2, 1, 1, 1], [3, 1, -1, 1]]);       // right
        face([[0, -1, -1, -1], [1, -1, 1, -1], [2, 1, 1, -1], [3, 1, -1, -1]]);   // back
        face([[3, 1, 1, 1], [2, -1, 1, 1], [1, -1, 1, -1], [0, 1, 1, -1]]);       // top
        face([[0, -1, -1, 1], [1, -1, -1, -1], [2, 1, -1, -1], [3, 1, -1, 1]]);   // bottom

        return result;
    }

    function generateCutPlanes(gear, gearAngle, tiers) {
        var origin = new Vertex3D();
        var stepAngle = 360.0 / gear;
        var rollAngleOffset = gearAngle * stepAngle;
        for (var i = 0; i < tiers.length; i++) {
            var tier = tiers[i];
            for (var j = 0; j < tier.indices.length; j++) {
                var pt = GeometryOperations.projectPoint(origin, tier.distance, 90);
                var pitchAngle = MathUtils.filterAngle(Math.abs(tier.angle) - 90);
                if (Math.sign(tier.angle) < 0) {
                    pitchAngle *= -1;
                }
                var rollAngle = tier.indices[j].index * stepAngle;
                pt = GeometryOperations.rotatePoint(pt, 0, 0, pitchAngle, origin);
                pt = GeometryOperations.rotatePoint(
                    pt, 0, MathUtils.filterAngle(rollAngle - rollAngleOffset), 0, origin);
                // `FacetNormal` is a plain auto-property in C#, so this rebinds
                // the reference rather than copying -- mirrored here.
                tier.indices[j].facetNormal =
                    GeometryOperations.projectPointAlongVector(pt, origin, -3.0);
            }
        }
    }

    /**
     * Clips `polygon` against the half-space behind a tier index's cut plane,
     * returning the cross-section points where the plane met its edges.  The
     * polygon is mutated in place: points in front of the plane are dropped and
     * the cross points are appended.
     */
    function cutPolygonByPlane(polygon, tierIndex) {
        var crossPoints = [];
        var planeNormal = tierIndex.facetNormal;
        var planePoint = GeometryOperations.projectPointAlongVector(
            planeNormal, new Vertex3D(), 3.0);
        var i, j;

        i = 0;
        while (true) {
            var fp1 = polygon.vertices[i].vertex;
            var fp2;
            if (i === polygon.vertices.length - 1) {
                fp2 = polygon.vertices[0].vertex;
            } else {
                fp2 = polygon.vertices[i + 1].vertex;
            }

            var d = planeNormal.x * (fp2.x - fp1.x) +
                planeNormal.y * (fp2.y - fp1.y) +
                planeNormal.z * (fp2.z - fp1.z);

            if (Math.abs(d) > TOLERANCE) {
                var delta = (planeNormal.x * (planePoint.x - fp1.x) +
                    planeNormal.y * (planePoint.y - fp1.y) +
                    planeNormal.z * (planePoint.z - fp1.z)) / d;
                if (Math.abs(delta) < TOLERANCE) {
                    delta = 0;
                }

                var cx = fp1.x + (fp2.x - fp1.x) * delta;
                var cy = fp1.y + (fp2.y - fp1.y) * delta;
                var cz = fp1.z + (fp2.z - fp1.z) * delta;

                if (delta >= 0 && delta <= 1) {
                    var crossPoint = new Vertex3D(cx, cy, cz);
                    var alreadyExists = false;
                    for (j = 0; j < crossPoints.length; j++) {
                        if (isSamePoint(crossPoint, crossPoints[j])) {
                            alreadyExists = true;
                            break;
                        }
                    }
                    if (!alreadyExists) {
                        crossPoints.push(crossPoint);
                    }
                }
            }

            i++;
            if (i === polygon.vertices.length) {
                break;
            }
        }

        i = polygon.vertices.length - 1;
        while (true) {
            var fpBack = polygon.vertices[i].vertex;
            var dBack = planeNormal.x * (fpBack.x - planePoint.x) +
                planeNormal.y * (fpBack.y - planePoint.y) +
                planeNormal.z * (fpBack.z - planePoint.z);
            if (dBack > 0) {
                polygon.removeAt(i);
            }
            i--;
            if (i === -1) {
                break;
            }
        }

        for (i = 0; i < crossPoints.length; i++) {
            planePoint = crossPoints[i];
            var exists = false;
            for (j = 0; j < polygon.vertices.length; j++) {
                if (isSamePoint(planePoint, polygon.vertices[j].vertex)) {
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                polygon.add(new PolygonVertex(
                    new Vertex3D(planePoint.x, planePoint.y, planePoint.z)));
            }
        }

        if (polygon.vertices.length > 3) {
            reArrangePoints(polygon);
        }

        return crossPoints;
    }

    function performCutsOnRoughCube(roughCube, tiers) {
        var polygons = roughCube.slice();
        var map = [];
        var h, i, j, k, l;

        for (h = 0; h < tiers.length; h++) {
            var tier = tiers[h];
            for (i = 0; i < tier.indices.length; i++) {
                var tierIndex = tier.indices[i];

                var cutPoints = [];
                var cutPolygon = new Polygon(0);

                for (j = 0; j < polygons.length; j++) {
                    var currentPolygon = polygons[j];
                    if (currentPolygon.vertices.length === 0) {
                        continue;
                    }

                    var crossPoints = cutPolygonByPlane(currentPolygon, tierIndex);

                    for (k = 0; k < crossPoints.length; k++) {
                        var point = crossPoints[k];
                        var alreadyExists = false;
                        for (l = 0; l < cutPoints.length; l++) {
                            if (isSamePoint(point, cutPoints[l])) {
                                alreadyExists = true;
                                break;
                            }
                        }
                        if (!alreadyExists) {
                            cutPoints.push(new Vertex3D(point.x, point.y, point.z));
                        }
                    }
                }

                for (j = 0; j < cutPoints.length; j++) {
                    var cp = cutPoints[j];
                    var dup = false;
                    for (k = 0; k < cutPolygon.vertices.length; k++) {
                        if (isSamePoint(cp, cutPolygon.vertices[k].vertex)) {
                            dup = true;
                            break;
                        }
                    }
                    if (!dup) {
                        cutPolygon.add(new PolygonVertex(new Vertex3D(cp.x, cp.y, cp.z)));
                    }
                }

                if (cutPolygon.vertices.length > 2) {
                    reArrangePoints(cutPolygon);
                    // The new facet joins the solid, so later cuts trim it too.
                    polygons.push(cutPolygon);
                    map.push([h, i, cutPolygon]);
                }
            }
        }

        for (var m = 0; m < map.length; m++) {
            tiers[map[m][0]].indices[map[m][1]].points =
                map[m][2].vertices.map(function (v) { return v.vertex; });
        }
    }

    /**
     * Parses one line of a .asc file into `fileData`.  `tierCounter` is a box
     * standing in for C#'s `ref int currentTier`.
     */
    function processAscLine(line, fileData, tierCounter, logger) {
        // PORT TRAP 7: StringSplitOptions.None keeps empty entries, and so does
        // JS split(" ").  Do not filter them: `parts.length` is tested against
        // exact counts below, and runs of spaces in header lines are content.
        var parts = line.split(" ").map(function (x) { return x.trim(); });

        if (parts.length === 0) {
            return;
        }

        if (parts[0] === "g") {
            if (parts.length === 3) {
                var gear = tryParseInt(parts[1]);
                var gearLocation = tryParseFloat(parts[2]);
                if (gear !== null && gearLocation !== null) {
                    logger.debug("[ASCIMPORT] Read gear and location " + gear + " " + gearLocation);
                    fileData.metadata.gear = gear;
                    fileData.metadata.gearLocationAngle = gearLocation;
                }
            }
        } else if (parts[0] === "y") {
            if (parts.length === 3) {
                var symmetryFolds = tryParseInt(parts[1]);
                if (symmetryFolds !== null) {
                    var symmetryMirror = parts[2].trim();
                    logger.debug("[ASCIMPORT] Read symmetry " + symmetryFolds + " " + symmetryMirror);
                    fileData.metadata.symmetryFolds = symmetryFolds;
                    fileData.metadata.symmetryMirror = symmetryMirror.toLowerCase() === "y";
                }
            }
        } else if (parts[0] === "I") {
            if (parts.length === 2) {
                var refractiveIndex = tryParseFloat(parts[1]);
                if (refractiveIndex !== null) {
                    logger.debug("[ASCIMPORT] Read index " + refractiveIndex);
                    fileData.metadata.refractiveIndex = refractiveIndex;
                }
            }
        } else if (parts[0] === "H") {
            if (parts.length > 1) {
                var header = parts.slice(1).join(" ");
                logger.debug("[ASCIMPORT] Read header " + header);
                fileData.metadata.headers.push(header);
            }
        } else if (parts[0] === "F") {
            if (parts.length > 1) {
                var footer = parts.slice(1).join(" ");
                logger.debug("[ASCIMPORT] Read footnote " + footer);
                fileData.metadata.footnotes.push(footer);
            }
        } else if (parts[0] === "a") {
            if (parts.length > 2) {
                var angle = tryParseFloat(parts[1]);
                var distance = tryParseFloat(parts[2]);
                if (angle !== null && distance !== null && parts.length > 3) {
                    // Walk the rest of the line.  Tokens are facet index
                    // numbers, "n <name>" pairs naming the index just read, or
                    // -- the moment a token is neither -- the start of the
                    // free-text cutting instructions.  This is exactly where a
                    // lenient parseFloat would go wrong; see tryParseFloat.
                    var facetIndices = [];
                    var index = 3;
                    var currentTierIndex = NaN;
                    var currentCuttingInstructions = "";
                    while (index < parts.length) {
                        if (parts[index] === "n") {
                            if (index + 1 >= parts.length) {
                                // C# indexes parts[index + 1] unconditionally and
                                // would throw IndexOutOfRangeException on a line
                                // ending in a bare "n".  Throwing here too keeps
                                // the failure mode the same instead of quietly
                                // recording an undefined facet name.
                                throw new RangeError(
                                    "Malformed 'a' line: 'n' with no facet name after it.");
                            }
                            if (!isNaN(currentTierIndex)) {
                                facetIndices.push([parts[index + 1], currentTierIndex]);
                                currentTierIndex = NaN;
                            }
                            index += 2;
                        } else {
                            var facetIndex = tryParseFloat(parts[index]);
                            if (facetIndex !== null) {
                                if (!isNaN(currentTierIndex)) {
                                    facetIndices.push(["", currentTierIndex]);
                                }
                                currentTierIndex = facetIndex;
                                index++;
                            } else {
                                if (!isNaN(currentTierIndex)) {
                                    facetIndices.push(["", currentTierIndex]);
                                    currentTierIndex = NaN;
                                }
                                currentCuttingInstructions = parts.slice(index).join(" ");
                                break;
                            }
                        }
                    }

                    if (!isNaN(currentTierIndex)) {
                        facetIndices.push(["", currentTierIndex]);
                    }

                    logger.debug("[ASCIMPORT] Read angle, distance, tier indices, and cutting " +
                        "instructions: " + angle + ", " + distance + ", " + facetIndices.length +
                        " indices, " + currentCuttingInstructions);

                    var tier = new GemCadFileTierData();
                    tierCounter.value += 1;
                    tier.number = tierCounter.value;
                    tier.angle = angle;
                    tier.distance = distance;
                    for (var t = 0; t < facetIndices.length; t++) {
                        var tierIndex = new GemCadFileTierIndexData();
                        tierIndex.tier = tierCounter.value;
                        tierIndex.name = facetIndices[t][0];
                        tierIndex.index = facetIndices[t][1];
                        tier.indices.push(tierIndex);
                    }

                    fileData.tiers.push(tier);
                }
            }
        }
        // NOTE: the original never records `CuttingInstructions` on the tier in
        // the ASC path -- it parses them and only logs them.  Left as is, so
        // that a .asc-parsed tier has cuttingInstructions === null just as in
        // the reference.  (The .gem path does fill the field in.)
    }

    /**
     * Reads a GemCad .asc design from its text.
     */
    function importAscText(text, logger) {
        logger = logger || nullLogger;
        var result = new GemCadFileData();

        // C#'s StreamReader strips a byte-order mark and splits on \r\n, \r or
        // \n, and never yields a final empty line for a trailing newline.
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        var lines = text.split(/\r\n|\n|\r/);
        if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
        }

        var tierCounter = { value: 0 };
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!isNullOrWhiteSpace(line)) {
                processAscLine(line, result, tierCounter, logger);
            }
        }

        if (result.tiers.length > 0) {
            generateCutPlanes(result.metadata.gear, result.metadata.gearLocationAngle, result.tiers);
            var roughCube = generateRoughCube();
            performCutsOnRoughCube(roughCube, result.tiers);
            buildRenderingTriangles(result, logger);
        }

        return result;
    }

    // =======================================================================
    // Concrete/GemCadGemImport.cs
    // =======================================================================

    /**
     * A cursor over a byte array that behaves like .NET's BinaryReader over a
     * FileStream.
     *
     * PORT TRAP 5: little-endian throughout, and the parser seeks *backwards* --
     * ParseBinaryData saves a position and restores it when its trailer-detection
     * guess is wrong, and readAnsiString(false) steps back one byte after
     * peeking.  So `position` is a plain mutable field, not an opaque stream.
     *
     * The read methods mirror .NET: ReadByte/ReadInt32/ReadDouble throw at the
     * end of the stream, while ReadBytes returns however many bytes are left.
     */
    function BinaryReader(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.position = 0;
    }

    Object.defineProperty(BinaryReader.prototype, "length", {
        get: function () { return this.bytes.length; }
    });

    BinaryReader.prototype.readByte = function () {
        if (this.position + 1 > this.length) {
            throw new RangeError("Unable to read beyond the end of the stream.");
        }
        return this.bytes[this.position++];
    };

    BinaryReader.prototype.readBytes = function (count) {
        var end = Math.min(this.position + count, this.length);
        var out = this.bytes.subarray(this.position, end);
        this.position = end;
        return out;
    };

    BinaryReader.prototype.readInt32 = function () {
        if (this.position + 4 > this.length) {
            throw new RangeError("Unable to read beyond the end of the stream.");
        }
        var value = this.view.getInt32(this.position, true);
        this.position += 4;
        return value;
    };

    BinaryReader.prototype.readDouble = function () {
        if (this.position + 8 > this.length) {
            throw new RangeError("Unable to read beyond the end of the stream.");
        }
        var value = this.view.getFloat64(this.position, true);
        this.position += 8;
        return value;
    };

    function readEodMarker(reader) {
        return reader.readInt32();
    }

    function read3DPoint(reader, out) {
        var result = new Vertex3D();
        result.x = reader.readDouble();
        result.y = reader.readDouble();
        result.z = reader.readDouble();
        out.eodMarker = readEodMarker(reader);
        return result;
    }

    /**
     * Length-prefixed ANSI string.  With `checkMarker` it is followed by a
     * 4-byte marker that is read and discarded; without it, an empty or
     * whitespace-only string is followed by a one-byte peek that is pushed back
     * when non-zero.  Both behaviours are load-bearing for staying in sync.
     */
    function readAnsiString(reader, checkMarker) {
        var result = "";
        var strLen = reader.readByte();
        if (strLen > 0) {
            result = asciiGetString(reader.readBytes(strLen));
        }

        if (checkMarker) {
            readEodMarker(reader);
        } else if (isNullOrWhiteSpace(result)) {
            if (reader.readByte() > 0) {
                reader.position -= 1;
            }
        }

        return result;
    }

    function parseBinaryData(reader, logger) {
        var currentTier = new GemCadFileTierData();
        currentTier.isPreform = false;
        currentTier.number = 1;
        var indexPoints = [];
        var indices = [];
        var parsedData = new GemCadFileData();
        var inPreform = false;

        while (reader.position < reader.length - 3) {
            // Upstream comment: "This is pretty jank, but it works. Should find
            // a better way of knowing we're at the trailer section."
            var tempPos = reader.position;
            var unknown1 = reader.readInt32();   // 0x0 marker
            var unknown2 = reader.readBytes(4);  // Unknown - but never all zeroes
            var symmetryFolds = reader.readInt32();
            var symmetryMirror = reader.readInt32();

            var unknown2Sum = 0;
            for (var u = 0; u < unknown2.length; u++) {
                unknown2Sum += unknown2[u];
            }

            if (unknown1 === 0 && unknown2Sum > 0 && symmetryFolds > 0 &&
                (symmetryMirror === 0 || symmetryMirror === 1)) {
                logger.debug("[GEMIMPORT] Parsing trailer record at offset " +
                    hex8(reader.position));
                parsedData.metadata.symmetryFolds = symmetryFolds;
                parsedData.metadata.symmetryMirror = symmetryMirror !== 0;
                parsedData.metadata.gear = reader.readInt32();
                parsedData.metadata.refractiveIndex = reader.readDouble();
                reader.readBytes(4); // unknown3 - same in all files
                parsedData.metadata.gearLocationAngle = reader.readDouble();

                logger.debug("[GEMIMPORT] Parsing trailer section text lines");
                var textLines = parsedData.metadata.headers;
                while (reader.position < reader.length - 3) {
                    var textLine = readAnsiString(reader, false);
                    if (!inPreform) {
                        if (!isNullOrWhiteSpace(textLine)) {
                            if (textLine.toLowerCase() === "preform") {
                                logger.debug("[GEMIMPORT] Detected PREFORM data");
                                inPreform = true;
                                break;
                            }
                            logger.debug("[GEMIMPORT] Parsed trailer text line: " + textLine);
                            textLines.push(textLine);
                        } else {
                            // A blank line separates the headers from the footnotes.
                            logger.debug("[GEMIMPORT] Switching to footnotes section");
                            textLines = parsedData.metadata.footnotes;
                        }
                    }
                }
            } else {
                // Not the trailer after all: rewind and read a tier index record.
                reader.position = tempPos;

                logger.debug("[GEMIMPORT] Parsing tier index record at offset " +
                    hex8(reader.position));
                var rec = new GemCadFileTierIndexData();
                var out = { eodMarker: 0 };
                rec.facetNormal = read3DPoint(reader, out);
                rec.tier = out.eodMarker;

                var text = readAnsiString(reader, true).split("\t");
                if (text.length > 0) { // always true; kept for fidelity
                    rec.name = text[0].trim();
                    if (text.length > 1) {
                        // NOTE (upstream quirk): this writes onto `currentTier`,
                        // which for the first record of a new tier is still the
                        // PREVIOUS tier, because the tier is only rolled over a
                        // few lines further down.  Mirrored deliberately.
                        if (isNullOrWhiteSpace(currentTier.cuttingInstructions)) {
                            currentTier.cuttingInstructions = text.slice(1).join("\t");
                        }
                    }
                }

                /* DELIBERATE DIVERGENCE FROM UPSTREAM (T-0161).
                 *
                 * Upstream reads the point list with `while (eodMarker > 0)`,
                 * reusing the same marker that follows the facet normal both as
                 * `rec.tier` (the record's real tier number) and as "are there
                 * points to read". That conflation is silently correct only
                 * because every upstream sample and, until now, every design in
                 * reference/gemology-project-designs/ happens to number every
                 * tier >= 1 -- so the marker is always truthy going into the
                 * loop. A tier legitimately numbered 0 (confirmed by hand from
                 * the raw bytes of three real designs -- Darts.gem, Pandoro.gem,
                 * Sierpinski's_Puzzle.gem -- where a real point with plausible
                 * coordinates sits exactly where the old `while` skips to)
                 * makes `rec.tier` falsy and the loop never runs, attributing 0
                 * points to a real facet and desyncing every record after it:
                 * "Tier index record has fewer than 3 points" a few records
                 * later, or a runaway "Unable to read beyond the end of the
                 * stream" once the desynced reads walk off the buffer.
                 *
                 * A point list always describes a physical facet, which always
                 * has at least one point, so the first point must be read
                 * unconditionally; only the SECOND and later points depend on
                 * the previous point's own trailing marker, exactly as before.
                 * For every tier >= 1 this is byte-identical to the old code,
                 * which already always entered the loop at least once.
                 */
                do {
                    indexPoints.push(read3DPoint(reader, out));
                } while (out.eodMarker > 0);

                if (currentTier.number !== rec.tier) {
                    currentTier.indices = indices.slice();
                    parsedData.tiers.push(currentTier);
                    indices.length = 0;
                    currentTier = new GemCadFileTierData();
                    currentTier.isPreform = inPreform;
                    currentTier.number = rec.tier;
                }

                rec.points = indexPoints.slice();
                indices.push(rec);
                indexPoints.length = 0;
            }
        }

        if (indices.length > 0) {
            currentTier.indices = indices.slice();
            parsedData.tiers.push(currentTier);
        }

        return parsedData;
    }

    function hex8(value) {
        var s = (value >>> 0).toString(16).toUpperCase();
        while (s.length < 8) {
            s = "0" + s;
        }
        return s;
    }

    /**
     * Back-computes each tier's angle, distance and per-facet index number from
     * the facet normals stored in the .gem file.
     */
    function calculateTierDefinitions(data, logger) {
        var origin = new Vertex3D();
        var stepAngle = 360.0 / data.metadata.gear;
        var rollAngleOffset = data.metadata.gearLocationAngle * stepAngle;
        logger.debug("[GEMIMPORT] Gear: " + data.metadata.gear + " Step Angle: " + stepAngle +
            " Gear Location Angle: " + data.metadata.gearLocationAngle +
            " Roll Offset Angle: " + rollAngleOffset);

        for (var i = 0; i < data.tiers.length; i++) {
            var tier = data.tiers[i];
            for (var j = 0; j < tier.indices.length; j++) {
                var index = tier.indices[j];

                if (j === 0) {
                    var angle;
                    // "< double.Epsilon" means "=== 0"; a facet normal with no
                    // horizontal component is the table or the culet.
                    if (Math.abs(index.facetNormal.x) < DOUBLE_EPSILON &&
                        Math.abs(index.facetNormal.y) < DOUBLE_EPSILON) {
                        if (Math.sign(index.facetNormal.z) > 0) {
                            angle = 0.0;
                        } else {
                            angle = -90.0;
                        }
                    } else {
                        angle = MathUtils.filterAngle(
                            GeometryOperations.angleBetweenConnectedVectors(
                                index.facetNormal,
                                origin,
                                new Vertex3D(index.facetNormal.x, index.facetNormal.y, 0)) - 90);
                        if (index.facetNormal.z < 0) {
                            angle *= -1;
                        }
                    }

                    // Banker's rounding, not JS Math.round -- see roundHalfToEven.
                    angle = roundHalfToEven(angle, 2);

                    if (index.points.length < 3) {
                        throw new Error(
                            "Tier index record has fewer than 3 points; cannot derive its plane.");
                    }
                    var triangle = GeometryOperations.createTriangleFromPoints(
                        index.points[0], index.points[1], index.points[2], true);
                    var intersect = VectorOperations.findRayPlaneIntersection(
                        origin, index.facetNormal, triangle);
                    var distance = GeometryOperations.length3d(origin, intersect);

                    tier.angle = angle;
                    tier.distance = distance;
                    logger.debug("[GEMIMPORT] Tier " + i + ": ANGLE=" + angle + " DIST=" +
                        distance + " PC=" + index.points.length);
                }

                /* DELIBERATE DIVERGENCE FROM UPSTREAM (T-0088).
                 *
                 * Everything else in this file mirrors the C# original bug for
                 * bug, because when it was ported there was no .NET here and
                 * "matches upstream" was the only checkable correctness
                 * property. This one place does not, because the original is
                 * wrong and we now have two oracles that are better than the
                 * reference implementation: the facet normal stored in the file
                 * itself, and the .asc of the same design.
                 *
                 * The original wrapped a negative index with
                 *
                 *     if (sign(indexAngle) < 0) indexAngle += gear;
                 *     indexAngle = abs(clockN(indexAngle, gear));
                 *
                 * Both steps assume `gear` is positive. GemCad writes a negative
                 * gear to mean the index wheel runs the other way (`g -96`), and
                 * then `+= gear` drives a negative value further negative while
                 * `abs` reflects it, so the recovered index comes back mirrored:
                 * tooth i is reported as `teeth - i`.
                 *
                 * Measured against the stored normals: Turkey.gem was wrong on
                 * 71 of 74 facets and CubeIllusionTri.gem on 51 of 51, by up to
                 * 165 degrees. It hid from the .asc/.gem comparison because
                 * these designs are mirror-symmetric, so reflecting the wheel
                 * maps each tier's *set* of indices onto itself -- only a
                 * per-facet check against that facet's own normal exposes it.
                 *
                 * Wrapping into [0, teeth) instead fixes it, and brings every
                 * .gem into agreement with its .asc modulo the tooth count on
                 * all four sample designs. Positive-gear files are unaffected
                 * apart from the on-axis facet below.
                 */
                var span = Math.abs(data.metadata.gear);
                var indexAngle;

                if (Math.abs(index.facetNormal.x) < DOUBLE_EPSILON &&
                    Math.abs(index.facetNormal.y) < DOUBLE_EPSILON) {
                    /* On the optical axis there is no azimuth: a table or culet
                     * facet is the same plane at every index position. Tooth 0
                     * by convention. The original wrote `gear` here, which came
                     * out as the tooth count itself -- the same tooth, since
                     * teeth == 0 (mod teeth), but it made two readings of one
                     * design compare unequal. */
                    indexAngle = 0;
                } else {
                    indexAngle = (GeometryOperations.getAngle2d(
                        origin,
                        new Vertex3D(index.facetNormal.x, index.facetNormal.y, 0)) -
                        90 + rollAngleOffset) / stepAngle * -1;
                }

                var indexVal = convertToInt32(roundHalfToEven(indexAngle, 0));

                index.index = ((indexVal % span) + span) % span;

                logger.debug("[GEMIMPORT] Tier " + i + " Index " + j + ": " + indexVal);
            }
        }
    }

    /**
     * Reads a GemCad .gem design from its bytes.
     */
    function importGemBytes(bytes, logger) {
        logger = logger || nullLogger;
        var data = parseBinaryData(new BinaryReader(bytes), logger);
        calculateTierDefinitions(data, logger);
        buildRenderingTriangles(data, logger);
        return data;
    }

    // =======================================================================
    // Concrete/GemCadFileFormatIdentifier.cs and GemCadFileImport.cs
    // =======================================================================

    /** Returns "ascii" or "binary". */
    function identifyFormat(bytes) {
        if (bytes.length > 7) {
            var str = asciiGetString(bytes.subarray(0, 7));
            return str === "GemCad " ? "ascii" : "binary";
        }
        throw new Error("Cannot identify file as a GemCad data file.");
    }

    function decodeUtf8(bytes) {
        return new TextDecoder("utf-8").decode(bytes);
    }

    /** The equivalent of `IGemCadFileImport.Import`, over bytes. */
    function importBytes(bytes, logger) {
        if (identifyFormat(bytes) === "ascii") {
            return importAscText(decodeUtf8(bytes), logger);
        }
        return importGemBytes(bytes, logger);
    }

    var nullLogger = {
        debug: function () {},
        info: function () {},
        error: function () {}
    };

    // =======================================================================
    // Public surface.  No ES module export: this file is inlined into a
    // file:// page as a classic script.
    // =======================================================================

    globalThis.GemCad = {
        // Entry points
        importBytes: importBytes,
        importAscText: importAscText,
        importGemBytes: importGemBytes,
        identifyFormat: identifyFormat,

        // Data types
        Vertex3D: Vertex3D,
        PolygonVertex: PolygonVertex,
        Polygon: Polygon,
        Triangle: Triangle,
        Quad: Quad,
        GemCadFileData: GemCadFileData,
        GemCadFileMetadata: GemCadFileMetadata,
        GemCadFileTierData: GemCadFileTierData,
        GemCadFileTierIndexData: GemCadFileTierIndexData,

        // Math and parsing helpers, exposed so they can be tested directly
        MathUtils: MathUtils,
        VectorOperations: VectorOperations,
        GeometryOperations: GeometryOperations,
        BinaryReader: BinaryReader,
        subdivideTriangles: subdivideTriangles,
        roundHalfToEven: roundHalfToEven,
        roundHalfToEvenInteger: roundHalfToEvenInteger,
        convertToInt32: convertToInt32,
        tryParseFloat: tryParseFloat,
        tryParseInt: tryParseInt,
        asciiGetString: asciiGetString,
        nullLogger: nullLogger,
        constants: { RADIAN: RADIAN, TOLERANCE: TOLERANCE, DOUBLE_EPSILON: DOUBLE_EPSILON }
    };
}());
