import assert from "node:assert/strict";
import test from "node:test";

import * as spatial from "./spatial-anchor.mjs";

const DOCUMENT_SHA256 = "a".repeat(64);
const OTHER_DOCUMENT_SHA256 = "b".repeat(64);
const PAGE_VIEW_BOX = Object.freeze([10, 20, 110, 220]);

function rendererRecipe(rotation = 0, rendererVersion = "6.3.289") {
  return spatial.createSpatialRendererRecipe({
    rendererVersion,
    pageViewBox: PAGE_VIEW_BOX,
    pageRotation: rotation,
  });
}

function baseInput(overrides = {}) {
  const rotation = overrides.rotation ?? 0;
  return {
    anchorId: "anchor:reader:1",
    paperRef: "paper:arbitrary:1",
    documentSha256: DOCUMENT_SHA256,
    pageIndex: 4,
    pageLabel: "v",
    pageViewBox: PAGE_VIEW_BOX,
    rotation,
    rendererRecipe: overrides.rendererRecipe ?? rendererRecipe(rotation),
    sourceKind: "visual_region",
    geometryKind: "rectangle",
    normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }],
    textItemRefs: [],
    createdBy: "human",
    createdAt: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

function mutableClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function omit(value, ...keys) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

test("normalized top-left points round-trip through PDF CropBox coordinates at every page rotation", () => {
  const normalized = { x: 0.2, y: 0.3 };
  const expected = new Map([
    [0, { x: 30, y: 160 }],
    [90, { x: 40, y: 60 }],
    [180, { x: 90, y: 80 }],
    [270, { x: 80, y: 180 }],
  ]);

  for (const rotation of [0, 90, 180, 270]) {
    const pdfPoint = spatial.normalizedTopLeftPointToPdfPoint(normalized, PAGE_VIEW_BOX, rotation);
    assert.deepEqual(pdfPoint, expected.get(rotation));
    assert.deepEqual(
      spatial.pdfPointToNormalizedTopLeftPoint(pdfPoint, PAGE_VIEW_BOX, rotation),
      normalized,
    );
    assert.equal(Object.isFrozen(pdfPoint), true);
  }
});

test("rectangles and non-axis-aligned quads preserve normalized geometry across rotations", () => {
  const rectangle = { x: 0.12, y: 0.18, width: 0.41, height: 0.27 };
  const normalizedQuad = [
    { x: 0.1, y: 0.1 },
    { x: 0.82, y: 0.2 },
    { x: 0.7, y: 0.84 },
    { x: 0.18, y: 0.72 },
  ];

  for (const rotation of [0, 90, 180, 270]) {
    const pdfRectangle = spatial.normalizedRectToPdfQuad(rectangle, PAGE_VIEW_BOX, rotation);
    assert.deepEqual(spatial.pdfQuadToNormalizedRect(pdfRectangle, PAGE_VIEW_BOX, rotation), rectangle);

    const pdfQuad = spatial.normalizedQuadToPdfQuad(normalizedQuad, PAGE_VIEW_BOX, rotation);
    assert.deepEqual(spatial.pdfQuadToNormalizedQuad(pdfQuad, PAGE_VIEW_BOX, rotation), normalizedQuad);
    assert.equal(Object.isFrozen(pdfQuad), true);
    assert.equal(Object.isFrozen(pdfQuad[0]), true);
  }
});

test("a 90-degree rectangle maps to display-ordered PDF points", () => {
  assert.deepEqual(
    spatial.normalizedRectToPdfQuad(
      { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      PAGE_VIEW_BOX,
      90,
    ),
    [
      { x: 30, y: 40 },
      { x: 30, y: 100 },
      { x: 55, y: 100 },
      { x: 55, y: 40 },
    ],
  );
});

test("renderer recipes are strict, immutable, and deterministically digested", async () => {
  const recipe = rendererRecipe(270);
  assert.deepEqual(recipe, {
    schemaVersion: 1,
    renderer: "pdfjs",
    rendererVersion: "6.3.289",
    geometryVersion: 1,
    normalizedCoordinateSpace: "viewport-top-left",
    pdfCoordinateSpace: "pdf-crop-box",
    pageViewBox: PAGE_VIEW_BOX,
    pageRotation: 270,
  });
  assert.equal(Object.isFrozen(recipe), true);
  assert.equal(Object.isFrozen(recipe.pageViewBox), true);
  const firstDigest = await spatial.computeSpatialRendererRecipeDigest(recipe);
  const secondDigest = await spatial.computeSpatialRendererRecipeDigest(mutableClone(recipe));
  assert.match(firstDigest, /^[0-9a-f]{64}$/u);
  assert.equal(secondDigest, firstDigest);
  assert.throws(
    () => spatial.createSpatialRendererRecipe({
      rendererVersion: "6.3.289",
      pageViewBox: PAGE_VIEW_BOX,
      pageRotation: 45,
    }),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_INVALID",
  );
  assert.throws(
    () => spatial.validateSpatialRendererRecipe({ ...mutableClone(recipe), scale: 1 }),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_INVALID",
  );
});

test("exact-text anchors derive PDF quads and both hashes without retaining caller mutability", async () => {
  const exactText = "A difficult but source-grounded passage.";
  const normalizedBounds = [
    { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    { x: 0.1, y: 0.25, width: 0.17, height: 0.04 },
  ];
  const input = baseInput({
    sourceKind: "exact_text",
    geometryKind: "text",
    normalizedBounds,
    quote: {
      exact: exactText,
      prefix: "Before",
      suffix: "After",
    },
    textItemRefs: ["page:5:item:1", "page:5:item:2"],
  });
  const anchor = await spatial.createSpatialAnchor(input);

  assert.equal(anchor.schemaVersion, 1);
  assert.equal(anchor.paperRef, "paper:arbitrary:1");
  assert.equal(anchor.documentSha256, DOCUMENT_SHA256);
  assert.equal(anchor.documentRevision, 1);
  assert.equal(anchor.coordinateSpace, "pdf-crop-box");
  assert.equal(anchor.normalizedCoordinateSpace, "viewport-top-left");
  assert.deepEqual(anchor.quote, {
    exact: exactText,
    prefix: "Before",
    suffix: "After",
    sha256: await spatial.sha256SpatialText(exactText),
    utf8Bytes: new TextEncoder().encode(exactText).byteLength,
  });
  assert.equal(anchor.authority, "exact_document_text");
  assert.equal(anchor.regionDigest, undefined);
  assert.equal(anchor.rendererRecipeDigest, await spatial.computeSpatialRendererRecipeDigest(anchor.rendererRecipe));
  assert.equal(anchor.anchorDigest, await spatial.computeSpatialAnchorDigest(anchor));
  assert.deepEqual(anchor.pdfQuads, normalizedBounds.map((rectangle) => (
    spatial.normalizedRectToPdfQuad(rectangle, PAGE_VIEW_BOX, 0)
  )));
  assert.equal(Object.isFrozen(anchor), true);
  assert.equal(Object.isFrozen(anchor.normalizedBounds), true);
  assert.equal(Object.isFrozen(anchor.normalizedBounds[0]), true);
  assert.equal(Object.isFrozen(anchor.pdfQuads[0]), true);

  normalizedBounds[0].x = 0.8;
  assert.equal(anchor.normalizedBounds[0].x, 0.1);
  const material = spatial.spatialAnchorDigestMaterial(anchor);
  assert.equal("anchorDigest" in material, false);
  assert.equal(Object.isFrozen(material), true);
});

test("canonical JSON and anchor digests do not depend on caller key insertion order", async () => {
  const original = await spatial.createSpatialAnchor(baseInput());
  const reorderedInput = {
    normalizedBounds: [{ height: 0.25, width: 0.3, y: 0.2, x: 0.1 }],
    sourceKind: "visual_region",
    geometryKind: "rectangle",
    rendererRecipe: mutableClone(original.rendererRecipe),
    rotation: 0,
    pageViewBox: [...PAGE_VIEW_BOX],
    pageLabel: "v",
    pageIndex: 4,
    documentSha256: DOCUMENT_SHA256,
    paperRef: "paper:arbitrary:1",
    anchorId: "anchor:reader:1",
    textItemRefs: [],
    createdBy: "human",
    createdAt: "2026-08-31T12:00:00.000Z",
  };
  const reordered = await spatial.createSpatialAnchor(reorderedInput);
  assert.equal(reordered.anchorDigest, original.anchorDigest);
  assert.equal(
    spatial.canonicalSpatialJson({ z: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"z":1}',
  );
});

test("point, rectangle, quadrilateral, and figure-region anchors receive canonical matching PDF geometry", async () => {
  const quad = [
    { x: 0.1, y: 0.1 },
    { x: 0.8, y: 0.2 },
    { x: 0.7, y: 0.8 },
    { x: 0.2, y: 0.7 },
  ];
  const fixtures = [
    {
      sourceKind: "visual_region",
      geometryKind: "point",
      normalizedPoints: [{ x: 0.2, y: 0.3 }],
      expectedField: "pdfPoints",
    },
    {
      sourceKind: "visual_region",
      geometryKind: "rectangle",
      normalizedBounds: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.25 }],
      expectedField: "pdfQuads",
    },
    {
      sourceKind: "visual_region",
      geometryKind: "quadrilateral",
      normalizedQuads: [quad],
      expectedField: "pdfQuads",
    },
    {
      sourceKind: "whole_figure",
      geometryKind: "quadrilateral",
      normalizedQuads: [quad],
      expectedField: "pdfQuads",
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const { expectedField, ...geometry } = fixture;
    const anchor = await spatial.createSpatialAnchor({
      ...omit(baseInput({
        anchorId: `anchor:shape:${index}`,
        rotation: 270,
        rendererRecipe: rendererRecipe(270),
      }), "normalizedBounds"),
      ...geometry,
    });
    assert.equal(anchor.sourceKind, fixture.sourceKind);
    assert.ok(Array.isArray(anchor[expectedField]));
    assert.equal(Object.isFrozen(anchor[expectedField]), true);
    assert.equal(await spatial.computeSpatialAnchorDigest(anchor), anchor.anchorDigest);
  }
});

test("spec source kinds retain honest authority, custody metadata, and optional rendered-region digests", async () => {
  const wholePage = await spatial.createSpatialAnchor(baseInput({
    anchorId: "anchor:page:5",
    sourceKind: "whole_page",
    geometryKind: "rectangle",
    normalizedBounds: [{ x: 0, y: 0, width: 1, height: 1 }],
    createdBy: "system",
  }));
  assert.equal(wholePage.sourceKind, "whole_page");
  assert.equal(wholePage.authority, "client_rendered_pdf");
  assert.equal(wholePage.createdBy, "system");
  assert.match(wholePage.regionDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(wholePage.textItemRefs, []);

  const equation = await spatial.createSpatialAnchor(baseInput({
    anchorId: "anchor:equation:5",
    sourceKind: "equation",
    geometryKind: "text",
    quote: { exact: "z = softmax(qkᵀ)v", prefix: "", suffix: "" },
    textItemRefs: ["page:5:item:equation"],
  }));
  assert.equal(equation.sourceKind, "equation");
  assert.equal(equation.authority, "exact_document_text");
  assert.equal(equation.regionDigest, undefined);
  assert.equal(equation.quote.exact, "z = softmax(qkᵀ)v");

  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      sourceKind: "whole_page",
      normalizedBounds: [{ x: 0, y: 0, width: 0.99, height: 1 }],
    })),
    (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
  );
});

test("canonical validation returns a detached frozen record bound to the active context", async () => {
  const anchor = await spatial.createSpatialAnchor(baseInput({ rotation: 180 }));
  const stored = mutableClone(anchor);
  const validated = await spatial.validateSpatialAnchor(stored, {
    paperRef: anchor.paperRef,
    documentSha256: anchor.documentSha256,
    pageIndex: anchor.pageIndex,
    rendererRecipe: anchor.rendererRecipe,
    rendererRecipeDigest: anchor.rendererRecipeDigest,
  });
  assert.deepEqual(validated, anchor);
  assert.notEqual(validated, stored);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.pdfQuads[0]), true);
});

test("validation rejects foreign paper, PDF bytes, page, and stale renderer contexts", async () => {
  const anchor = await spatial.createSpatialAnchor(baseInput());
  await assert.rejects(
    spatial.validateSpatialAnchor(anchor, { paperRef: "paper:foreign" }),
    (error) => error?.code === "SPATIAL_FOREIGN_PAPER",
  );
  await assert.rejects(
    spatial.validateSpatialAnchor(anchor, { documentSha256: OTHER_DOCUMENT_SHA256 }),
    (error) => error?.code === "SPATIAL_FOREIGN_DOCUMENT",
  );
  await assert.rejects(
    spatial.validateSpatialAnchor(anchor, { pageIndex: 5 }),
    (error) => error?.code === "SPATIAL_FOREIGN_PAGE",
  );
  await assert.rejects(
    spatial.validateSpatialAnchor(anchor, { rendererRecipe: rendererRecipe(0, "6.4.0") }),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_STALE",
  );
  await assert.rejects(
    spatial.validateSpatialAnchor(anchor, { rendererRecipeDigest: "0".repeat(64) }),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_STALE",
  );
});

test("factory rejects stale page recipes, closed-schema violations, and invalid page metadata", async () => {
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      rotation: 90,
      rendererRecipe: rendererRecipe(0),
    })),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_STALE",
  );
  await assert.rejects(
    spatial.createSpatialAnchor({ ...baseInput(), modelCoordinates: true }),
    (error) => error?.code === "SPATIAL_ANCHOR_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({ pageViewBox: [0, 0, 0, 100] })),
    (error) => error?.code === "SPATIAL_PAGE_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      rotation: 45,
      rendererRecipe: rendererRecipe(0),
    })),
    (error) => error?.code === "SPATIAL_PAGE_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({ documentSha256: DOCUMENT_SHA256.toUpperCase() })),
    (error) => error?.code === "SPATIAL_ANCHOR_INVALID",
  );
});

test("non-finite, out-of-page, zero-area, and excessive geometry fails closed", async () => {
  const invalidBounds = [
    [{ x: Number.NaN, y: 0.1, width: 0.2, height: 0.2 }],
    [{ x: 0.9, y: 0.1, width: 0.2, height: 0.2 }],
    [{ x: 0.1, y: 0.1, width: 0, height: 0.2 }],
  ];
  for (const normalizedBounds of invalidBounds) {
    await assert.rejects(
      spatial.createSpatialAnchor(baseInput({ normalizedBounds })),
      (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
    );
  }
  await assert.rejects(
    spatial.createSpatialAnchor({
      ...omit(baseInput(), "normalizedBounds"),
      sourceKind: "visual_region",
      geometryKind: "point",
      normalizedPoints: [{ x: 1.01, y: 0.2 }],
    }),
    (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      sourceKind: "exact_text",
      geometryKind: "text",
      normalizedBounds: Array.from({ length: 33 }, () => ({ x: 0.1, y: 0.1, width: 0.01, height: 0.01 })),
      quote: { exact: "bounded source" },
    })),
    (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
  );
});

test("degenerate, collinear, concave, and bow-tie quadrilaterals are rejected", async () => {
  const invalidQuads = [
    [
      { x: 0.1, y: 0.1 },
      { x: 0.1, y: 0.1 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ],
    [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
      { x: 0.5, y: 0.5 },
      { x: 0.7, y: 0.7 },
    ],
    [
      { x: 0.1, y: 0.1 },
      { x: 0.8, y: 0.1 },
      { x: 0.4, y: 0.4 },
      { x: 0.1, y: 0.8 },
    ],
    [
      { x: 0.1, y: 0.1 },
      { x: 0.8, y: 0.8 },
      { x: 0.8, y: 0.1 },
      { x: 0.1, y: 0.8 },
    ],
  ];
  for (const quad of invalidQuads) {
    await assert.rejects(
      spatial.createSpatialAnchor({
        ...omit(baseInput(), "normalizedBounds"),
        sourceKind: "visual_region",
        geometryKind: "quadrilateral",
        normalizedQuads: [quad],
      }),
      (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
    );
  }
});

test("exact-text hashes must match and exact-text anchors cannot omit text", async () => {
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      sourceKind: "exact_text",
      geometryKind: "text",
      quote: { exact: "evidence", sha256: "0".repeat(64) },
    })),
    (error) => error?.code === "SPATIAL_EXACT_TEXT_HASH_MISMATCH",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({ sourceKind: "exact_text", geometryKind: "text" })),
    (error) => error?.code === "SPATIAL_ANCHOR_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({ quote: { sha256: "0".repeat(64) } })),
    (error) => error?.code === "SPATIAL_ANCHOR_INVALID",
  );
  await assert.rejects(
    spatial.createSpatialAnchor(baseInput({
      sourceKind: "exact_text",
      geometryKind: "text",
      quote: { exact: "x".repeat(1_201) },
    })),
    (error) => error?.code === "SPATIAL_EXACT_TEXT_INVALID",
  );
});

test("persisted text, renderer, geometry, and anchor tampering is rejected before use", async () => {
  const exactAnchor = await spatial.createSpatialAnchor(baseInput({
    sourceKind: "exact_text",
    geometryKind: "text",
    quote: { exact: "immutable evidence" },
  }));
  const changedText = mutableClone(exactAnchor);
  changedText.quote.exact = "changed evidence";
  await assert.rejects(
    spatial.validateSpatialAnchor(changedText),
    (error) => error?.code === "SPATIAL_EXACT_TEXT_HASH_MISMATCH",
  );

  const changedRecipe = mutableClone(exactAnchor);
  changedRecipe.rendererRecipe.rendererVersion = "6.4.0";
  await assert.rejects(
    spatial.validateSpatialAnchor(changedRecipe),
    (error) => error?.code === "SPATIAL_RENDERER_RECIPE_STALE",
  );

  const changedGeometry = mutableClone(exactAnchor);
  changedGeometry.pdfQuads[0][0].x += 1;
  await assert.rejects(
    spatial.validateSpatialAnchor(changedGeometry),
    (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
  );

  const visualAnchor = await spatial.createSpatialAnchor(baseInput());
  const changedRegionDigest = mutableClone(visualAnchor);
  changedRegionDigest.regionDigest = "0".repeat(64);
  changedRegionDigest.anchorDigest = await spatial.computeSpatialAnchorDigest(changedRegionDigest);
  await assert.rejects(
    spatial.validateSpatialAnchor(changedRegionDigest),
    (error) => error?.code === "SPATIAL_REGION_DIGEST_MISMATCH",
  );

  const changedLabel = mutableClone(exactAnchor);
  changedLabel.pageLabel = "different";
  await assert.rejects(
    spatial.validateSpatialAnchor(changedLabel),
    (error) => error?.code === "SPATIAL_ANCHOR_DIGEST_MISMATCH",
  );
});

test("persisted PDF points outside the CropBox and unknown canonical fields are rejected", async () => {
  const pointAnchor = await spatial.createSpatialAnchor({
    ...omit(baseInput(), "normalizedBounds"),
    sourceKind: "visual_region",
    geometryKind: "point",
    normalizedPoints: [{ x: 0.2, y: 0.3 }],
  });
  const outside = mutableClone(pointAnchor);
  outside.pdfPoints[0].x = PAGE_VIEW_BOX[0] - 1;
  await assert.rejects(
    spatial.validateSpatialAnchor(outside),
    (error) => error?.code === "SPATIAL_GEOMETRY_INVALID",
  );
  await assert.rejects(
    spatial.validateSpatialAnchor({ ...mutableClone(pointAnchor), exportPdf: true }),
    (error) => error?.code === "SPATIAL_ANCHOR_INVALID",
  );
});
