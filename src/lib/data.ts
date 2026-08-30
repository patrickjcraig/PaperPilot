import type {
  Collection,
  ConnectedResearchTool,
  DashboardMetric,
  EvidenceNote,
  GuidedReadingPrompt,
  Paper,
  PaperFigure,
  PaperHighlight,
  PaperSection,
  Provenance,
  ResearchActivity,
  ResearchGoal,
} from "./types";

const DEMO_RETRIEVED_AT = "2026-08-28T12:00:00.000Z";

function paperProvenance(
  id: string,
  paper: Pick<Paper, "id" | "title" | "sourceUrl">,
  locator?: Provenance["locator"],
  excerpt?: string,
): Provenance {
  return {
    id,
    sourceType: locator?.figureId ? "figure" : "paper",
    sourceId: paper.id,
    sourceTitle: paper.title,
    sourceUrl: paper.sourceUrl,
    providerName: "PaperPilot demo corpus",
    retrievedAt: DEMO_RETRIEVED_AT,
    accessMethod: "seeded-demo",
    locator,
    excerpt,
    version: "demo-corpus-1.0",
  };
}

export const researchGoal: ResearchGoal = {
  id: "goal-laminography-packaging",
  title: "Limited-angle laminography for advanced packaging",
  query: "Understand limited-angle laminography for advanced semiconductor packaging",
  description:
    "Map which acquisition geometries and reconstruction methods can expose buried defects in wide, flat semiconductor packages—and identify where the evidence is still weak.",
  status: "active",
  topicTags: ["X-ray laminography", "advanced packaging", "limited angle", "reconstruction"],
  createdAt: "2026-08-25T13:40:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
};

export const papers: Paper[] = [
  {
    id: "chen-2024-laminography",
    title:
      "Limited-angle X-ray laminography for non-destructive inspection of heterogeneous advanced packages",
    shortTitle: "Limited-angle laminography for advanced packages",
    authors: ["Maya R. Chen", "Jonas Feld", "Priya Natarajan", "Elena Kovacs"],
    year: 2024,
    venue: "IEEE Transactions on Components, Packaging and Manufacturing Technology",
    type: "application study",
    abstract:
      "Wide, planar semiconductor packages remain difficult to inspect with conventional computed tomography because the package aspect ratio restricts usable projection angles. This study evaluates a limited-angle cone-beam laminography geometry for non-destructive imaging of micro-bumps, redistribution layers, and underfill voids in heterogeneous packages. An angle-aware iterative reconstruction is compared with filtered backprojection and a standard total-variation baseline on a calibrated test vehicle. Across two defect classes, the proposed workflow improves contrast-to-noise ratio and preserves defect visibility near the central plane, while performance degrades for features aligned with the missing angular wedge. The results position laminography as a useful inspection strategy, but not a universal substitute for complete-angle CT.",
    abstractSnippet:
      "Evaluates a limited-angle cone-beam geometry on an advanced-packaging test vehicle, with explicit baselines and defect-level results.",
    whyRead:
      "Read first: it connects acquisition geometry, reconstruction choices, and package-level defects in one controlled study—and states the missing-angle limitation plainly.",
    relevanceScore: 98,
    relevanceTags: ["limited-angle", "advanced packaging", "defect inspection", "iterative reconstruction"],
    evidenceStrength: "strong",
    readingStatus: "reading",
    readingProgress: 62,
    estimatedMinutes: 18,
    citationCount: 18,
    identifiers: [{ scheme: "provider", value: "demo:chen-2024-laminography" }],
    sourceUrl: "https://example.org/paperpilot/demo/chen-2024-laminography",
    isDemoRecord: true,
  },
  {
    id: "okafor-2023-primal-dual",
    title: "Learned primal-dual reconstruction for sparse-view computed laminography",
    shortTitle: "Learned primal-dual laminography",
    authors: ["Adaeze Okafor", "Lars Pettersson", "Hiro Tanaka"],
    year: 2023,
    venue: "NDT & E International",
    type: "methods paper",
    abstract:
      "A physics-informed learned primal-dual network is adapted to laminographic trajectories and evaluated under sparse-view and truncated-field conditions. Simulation and composite-panel experiments compare the method with algebraic reconstruction, total variation, and image-domain denoising. The network recovers small inclusions at lower view counts, while cross-material transfer exposes calibration and domain-shift sensitivity.",
    abstractSnippet:
      "A learned reconstruction method tested against algebraic and total-variation baselines under sparse-view acquisition.",
    whyRead:
      "Use it to understand the performance ceiling of learned reconstruction—and the domain-shift risk hidden by in-distribution benchmarks.",
    relevanceScore: 93,
    relevanceTags: ["learned reconstruction", "sparse-view", "physics-informed", "domain shift"],
    evidenceStrength: "promising",
    readingStatus: "queued",
    readingProgress: 0,
    estimatedMinutes: 22,
    citationCount: 31,
    identifiers: [{ scheme: "provider", value: "demo:okafor-2023-primal-dual" }],
    sourceUrl: "https://example.org/paperpilot/demo/okafor-2023-primal-dual",
    isDemoRecord: true,
  },
  {
    id: "silva-2022-artifact-aware",
    title: "Artifact-aware iterative reconstruction in limited-angle cone-beam tomography",
    shortTitle: "Artifact-aware limited-angle reconstruction",
    authors: ["Rafael Silva", "Nina Bergström", "Wei-Lun Hsu", "Amal Desai"],
    year: 2022,
    venue: "IEEE Transactions on Medical Imaging",
    type: "methods paper",
    abstract:
      "This work derives a directionally weighted regularizer from the measured angular support of a cone-beam scan. Phantom and ex-vivo experiments show reduced missing-wedge streaking relative to isotropic total variation, with an ablation study separating geometry weighting from parameter tuning. The study is not packaging-specific but offers unusually clear artifact analysis.",
    abstractSnippet:
      "Derives an angular-support-aware regularizer and includes an unusually useful ablation of missing-wedge artifacts.",
    whyRead:
      "Read for the clearest account of why limited angles create directional artifacts; translate the method cautiously because the specimens are not packages.",
    relevanceScore: 88,
    relevanceTags: ["missing wedge", "artifact suppression", "regularization", "cone-beam CT"],
    evidenceStrength: "strong",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 26,
    citationCount: 74,
    identifiers: [{ scheme: "provider", value: "demo:silva-2022-artifact-aware" }],
    sourceUrl: "https://example.org/paperpilot/demo/silva-2022-artifact-aware",
    isDemoRecord: true,
  },
  {
    id: "bauer-2021-planar-electronics",
    title:
      "X-ray computed laminography of planar electronic assemblies: Geometry, resolution, and defect sensitivity",
    shortTitle: "Laminography of planar electronics",
    authors: ["Sophie Bauer", "Martin Ruiz", "Kelvin Wong"],
    year: 2021,
    venue: "Measurement Science and Technology",
    type: "review",
    abstract:
      "A tutorial review links laminographic tilt angle, magnification, sampling, and anisotropic spatial resolution to defect detectability in printed circuit boards and planar electronic assemblies. Published experiments are normalized by feature scale, and common reporting gaps are catalogued. The review predates several neural methods but provides a stable vocabulary for comparing acquisition geometries.",
    abstractSnippet:
      "A geometry-first review that standardizes how resolution and defect sensitivity are reported for planar assemblies.",
    whyRead:
      "Read early as the conceptual map: it defines the geometry terms needed to compare newer methods without conflating resolution and visibility.",
    relevanceScore: 86,
    relevanceTags: ["geometry", "planar electronics", "resolution", "review"],
    evidenceStrength: "foundational",
    readingStatus: "reviewed",
    readingProgress: 100,
    estimatedMinutes: 30,
    citationCount: 119,
    identifiers: [{ scheme: "provider", value: "demo:bauer-2021-planar-electronics" }],
    sourceUrl: "https://example.org/paperpilot/demo/bauer-2021-planar-electronics",
    isDemoRecord: true,
  },
  {
    id: "kim-2020-tsv-synchrotron",
    title: "High-resolution inspection of through-silicon vias using synchrotron X-ray laminography",
    shortTitle: "Synchrotron laminography of TSVs",
    authors: ["Seoyeon Kim", "Marc Leclerc", "Fatima Zahra", "David I. Ng"],
    year: 2020,
    venue: "Journal of Synchrotron Radiation",
    type: "application study",
    abstract:
      "Synchrotron laminography is used to visualize voiding and interfacial separation around through-silicon vias in a thinned wafer stack. Correlative cross-section microscopy validates a subset of defects. The experiment demonstrates high-resolution feasibility while relying on beamline access, a narrow specimen class, and destructive validation for ground truth.",
    abstractSnippet:
      "Correlates laminographic TSV observations with cross-section microscopy, offering rare defect-level validation.",
    whyRead:
      "Read for ground-truth methodology and defect morphology, while separating synchrotron feasibility from factory-ready inspection.",
    relevanceScore: 81,
    relevanceTags: ["through-silicon vias", "synchrotron", "ground truth", "void detection"],
    evidenceStrength: "strong",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 17,
    citationCount: 47,
    identifiers: [{ scheme: "provider", value: "demo:kim-2020-tsv-synchrotron" }],
    sourceUrl: "https://example.org/paperpilot/demo/kim-2020-tsv-synchrotron",
    isDemoRecord: true,
  },
  {
    id: "patel-2024-uncertainty-ct",
    title: "Uncertainty-calibrated neural reconstruction for industrial X-ray CT",
    shortTitle: "Uncertainty-calibrated industrial CT",
    authors: ["Ishan Patel", "Léa Fournier", "Monica Graves", "Tobias Hahn"],
    year: 2024,
    venue: "IEEE Transactions on Industrial Informatics",
    type: "methods paper",
    abstract:
      "An ensemble reconstruction model produces voxel-level uncertainty alongside industrial CT volumes. Calibration is assessed under view reduction, detector noise, and material shift. Uncertainty maps correlate with reconstruction error but become overconfident outside the training material set. Although conventional circular CT is used, the evaluation framework is relevant to defensible limited-angle inference.",
    abstractSnippet:
      "Pairs neural reconstruction with voxel-level uncertainty and tests calibration under acquisition and material shifts.",
    whyRead:
      "Read after the core laminography papers to design an evidence trail that exposes model uncertainty instead of presenting reconstructions as certain.",
    relevanceScore: 76,
    relevanceTags: ["uncertainty", "industrial CT", "calibration", "neural reconstruction"],
    evidenceStrength: "contextual",
    readingStatus: "unread",
    readingProgress: 0,
    estimatedMinutes: 21,
    citationCount: 12,
    identifiers: [{ scheme: "provider", value: "demo:patel-2024-uncertainty-ct" }],
    sourceUrl: "https://example.org/paperpilot/demo/patel-2024-uncertainty-ct",
    isDemoRecord: true,
  },
];

export const selectedPaperId = "chen-2024-laminography";

export const selectedPaper = papers.find((paper) => paper.id === selectedPaperId) as Paper;

export const paperSections: PaperSection[] = [
  {
    id: "chen-abstract",
    paperId: selectedPaperId,
    order: 1,
    title: "Abstract",
    kind: "abstract",
    pageStart: 1,
    pageEnd: 1,
    readingMinutes: 2,
    progress: 100,
    summaryLabel: "Claim and scope",
    figureIds: [],
    paragraphs: [
      {
        id: "chen-abstract-p1",
        page: 1,
        text:
          "Wide, planar semiconductor packages are poorly matched to complete-rotation computed tomography: at high magnification, their lateral extent collides with the source or detector before a full orbit can be acquired. We evaluate a 35° tilted-axis cone-beam laminography trajectory as a non-destructive alternative for a heterogeneous packaging test vehicle containing micro-bumps, redistribution layers, and seeded underfill voids.",
        highlightIds: ["hl-problem"],
      },
      {
        id: "chen-abstract-p2",
        page: 1,
        text:
          "Against filtered backprojection and isotropic total-variation reconstruction, the angle-aware method increases defect-region contrast-to-noise ratio while preserving 18–25 μm void visibility near the package mid-plane. Recovery remains orientation-dependent: interfaces whose normals lie inside the missing angular wedge are blurred or elongated. Laminography therefore expands the inspectable field for planar packages, but does not remove the need to report geometry-specific blind spots.",
        highlightIds: ["hl-central-claim", "hl-limit-abstract"],
      },
    ],
  },
  {
    id: "chen-introduction",
    paperId: selectedPaperId,
    order: 2,
    number: "1",
    title: "Why planar packages break the CT assumption",
    kind: "introduction",
    pageStart: 1,
    pageEnd: 3,
    readingMinutes: 4,
    progress: 100,
    summaryLabel: "Problem framing",
    figureIds: [],
    paragraphs: [
      {
        id: "chen-intro-p1",
        page: 2,
        text:
          "Heterogeneous integration places dense interconnects beneath heat spreaders, interposers, and wide organic substrates. Conventional radiography collapses those layers into a projection; conventional micro-CT can separate them only when the complete rotation remains physically possible. For 70 mm-class packages, the clearance constraint forces lower magnification precisely where micro-bump and fine-void inspection needs higher sampling.",
      },
      {
        id: "chen-intro-p2",
        page: 2,
        text:
          "Computed laminography trades angular completeness for access. Tilting the rotation axis spreads information about planar layers across projections while leaving an unsampled wedge in frequency space. The practical question is therefore not whether laminography produces an artifact-free volume, but whether its anisotropic evidence is sufficient for a specified defect, depth, and orientation.",
        highlightIds: ["hl-framing"],
      },
      {
        id: "chen-intro-p3",
        page: 3,
        text:
          "We ask whether an acquisition-aware reconstruction can improve void and bridge visibility under a fixed 240-view scan budget. Our contribution is a controlled comparison on the same raw projections, paired with destructive cross-sections for 24 seeded defect sites. We do not claim generalization to copper-dense packages, arbitrary defect orientations, or production-line throughput.",
        highlightIds: ["hl-contribution"],
      },
    ],
  },
  {
    id: "chen-methods",
    paperId: selectedPaperId,
    order: 3,
    number: "2",
    title: "Acquisition geometry and reconstruction",
    kind: "methods",
    pageStart: 3,
    pageEnd: 6,
    readingMinutes: 5,
    progress: 78,
    summaryLabel: "Assumptions and baseline",
    figureIds: ["fig-geometry"],
    paragraphs: [
      {
        id: "chen-method-p1",
        page: 3,
        text:
          "The test vehicle combines a 45 × 45 mm silicon interposer, two logic dies, 40 μm-pitch micro-bumps, and an epoxy underfill layer. Laser-drilled voids of 18, 25, and 40 μm were distributed at three depths; six copper bridges were added between adjacent bump sites. Metallographic cross-sections were registered after scanning and treated as reference labels within an estimated ±6 μm alignment tolerance.",
        highlightIds: ["hl-ground-truth"],
      },
      {
        id: "chen-method-p2",
        page: 4,
        text:
          "A laboratory cone-beam source acquired 240 projections over 360° around an axis tilted 35° from the detector normal. Tube voltage, exposure, geometric magnification, detector binning, and all preprocessing were fixed across reconstruction methods. The scan required 14 minutes; reconstruction times were excluded from the acquisition comparison.",
        highlightIds: ["hl-geometry"],
      },
      {
        id: "chen-method-p3",
        page: 5,
        text:
          "We compare Feldkamp-style filtered backprojection (FBP), isotropic total variation (TV), and an angle-aware primal-dual reconstruction (AA-PD). AA-PD penalizes gradients in proportion to local directional support predicted by the system matrix. Hyperparameters were selected on a separate calibration coupon, then held fixed for the packaging test vehicle.",
        highlightIds: ["hl-baselines"],
      },
      {
        id: "chen-method-p4",
        page: 6,
        text:
          "Primary outcomes are defect-level sensitivity, false-positive count, and contrast-to-noise ratio (CNR). A defect counts as detected when two blinded reviewers mark a localized discontinuity within 30 μm of the registered reference site. Inter-reviewer disagreement is resolved jointly; specificity cannot be estimated beyond the annotated candidate regions.",
        highlightIds: ["hl-outcomes"],
      },
    ],
  },
  {
    id: "chen-results",
    paperId: selectedPaperId,
    order: 4,
    number: "3",
    title: "Defect visibility depends on orientation",
    kind: "results",
    pageStart: 6,
    pageEnd: 9,
    readingMinutes: 5,
    progress: 34,
    summaryLabel: "Evidence and comparison",
    figureIds: ["fig-results"],
    paragraphs: [
      {
        id: "chen-results-p1",
        page: 7,
        text:
          "AA-PD recovered 20 of 24 seeded voids, compared with 16 for TV and 11 for FBP. All methods detected the 40 μm sites. The largest separation occurred at 18 μm: AA-PD recovered five of eight, TV two of eight, and FBP none. The per-defect analysis is descriptive; with 24 sites, confidence intervals remain wide.",
        highlightIds: ["hl-primary-result"],
      },
      {
        id: "chen-results-p2",
        page: 7,
        text:
          "Median defect-region CNR was 4.8 for AA-PD, 3.5 for TV, and 2.1 for FBP. Relative improvement was consistent across depth strata, although absolute CNR dropped in the copper-dense lower redistribution layer. AA-PD produced two candidate-region false positives, TV produced one, and FBP produced four.",
        highlightIds: ["hl-cnr-result"],
      },
      {
        id: "chen-results-p3",
        page: 8,
        text:
          "The bridge experiment exposed the missing-wedge boundary. Bridges close to the best-supported in-plane direction were sharply localized, but two bridges aligned within 12° of the least-supported direction appeared elongated across adjacent bump sites. Angle-aware regularization reduced streak amplitude without recovering boundary information absent from the projections.",
        highlightIds: ["hl-orientation-result"],
      },
    ],
  },
  {
    id: "chen-limitations",
    paperId: selectedPaperId,
    order: 5,
    number: "4",
    title: "Limits, transfer, and inspection claims",
    kind: "limitations",
    pageStart: 9,
    pageEnd: 10,
    readingMinutes: 3,
    progress: 0,
    summaryLabel: "Boundary conditions",
    figureIds: [],
    paragraphs: [
      {
        id: "chen-limit-p1",
        page: 9,
        text:
          "The experiment uses one package design and seeded, approximately spherical voids. Natural delamination, cracks, and irregular underfill defects may interact differently with angular support. Because scoring was restricted to registered candidate regions, the reported false-positive counts should not be interpreted as full-volume specificity.",
        highlightIds: ["hl-specificity-limit"],
      },
      {
        id: "chen-limit-p2",
        page: 9,
        text:
          "The 14-minute scan and offline AA-PD reconstruction do not meet inline inspection requirements. The current evidence supports failure-analysis and process-development use cases. Throughput, calibration drift, and transfer across package stacks require separate evaluation before deployment claims are justified.",
        highlightIds: ["hl-throughput-limit"],
      },
      {
        id: "chen-limit-p3",
        page: 10,
        text:
          "A useful laminography result must be reported together with tilt angle, sampling, material stack, defect orientation, and a statement of the expected blind directions. Reconstruction quality alone cannot turn an unobserved boundary into evidence.",
        highlightIds: ["hl-conclusion"],
      },
    ],
  },
];

export const paperFigures: PaperFigure[] = [
  {
    id: "fig-geometry",
    paperId: selectedPaperId,
    sectionId: "chen-methods",
    label: "Figure 2",
    title: "Tilted acquisition and the missing angular wedge",
    caption:
      "The package rotates around a 35° tilted axis. Measured projection normals cover the blue band; the amber wedge denotes unsampled directions. Defects are shown schematically, not to scale.",
    page: 4,
    altText:
      "Diagram of a flat package on a tilted rotation axis, with a blue measured-angle band and an amber missing wedge in frequency space.",
    visualKind: "diagram",
    findings: [
      "Tilting preserves clearance for the wide package at the chosen magnification.",
      "Angular support remains anisotropic; the trajectory has a predictable blind direction.",
      "Method comparisons reuse the identical 240-projection acquisition.",
    ],
    evidenceStrength: "foundational",
  },
  {
    id: "fig-results",
    paperId: selectedPaperId,
    sectionId: "chen-results",
    label: "Figure 5",
    title: "Matched reconstruction crops at seeded defect sites",
    caption:
      "Registered crops for 18 μm and 25 μm voids and two copper bridges. AA-PD improves localization for supported orientations; every reconstruction elongates the least-supported bridge.",
    page: 8,
    altText:
      "A comparison matrix with FBP, TV, AA-PD, and cross-section reference columns for four seeded defect sites.",
    visualKind: "comparison",
    findings: [
      "AA-PD makes the smallest supported void visible where both baselines miss it.",
      "TV remains competitive on the larger 25 μm void.",
      "All three methods elongate the bridge aligned with the missing wedge.",
    ],
    evidenceStrength: "strong",
  },
];

export const paperHighlights: PaperHighlight[] = [
  {
    id: "hl-problem",
    paperId: selectedPaperId,
    sectionId: "chen-abstract",
    paragraphId: "chen-abstract-p1",
    page: 1,
    text:
      "At high magnification, wide planar packages collide with the source or detector before a full CT orbit can be acquired.",
    role: "central-claim",
    marginLabel: "Problem",
    provenance: paperProvenance(
      "prov-hl-problem",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-abstract",
        sectionTitle: "Abstract",
        page: 1,
        paragraphId: "chen-abstract-p1",
      },
      "Wide, planar semiconductor packages are poorly matched to complete-rotation computed tomography.",
    ),
  },
  {
    id: "hl-central-claim",
    paperId: selectedPaperId,
    sectionId: "chen-abstract",
    paragraphId: "chen-abstract-p2",
    page: 1,
    text:
      "The angle-aware method increases defect-region contrast while preserving small-void visibility near the package mid-plane.",
    role: "central-claim",
    marginLabel: "Main claim",
    provenance: paperProvenance(
      "prov-hl-central-claim",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-abstract",
        sectionTitle: "Abstract",
        page: 1,
        paragraphId: "chen-abstract-p2",
      },
      "The angle-aware method increases defect-region contrast-to-noise ratio while preserving 18–25 μm void visibility.",
    ),
  },
  {
    id: "hl-limit-abstract",
    paperId: selectedPaperId,
    sectionId: "chen-abstract",
    paragraphId: "chen-abstract-p2",
    page: 1,
    text: "Recovery remains orientation-dependent near the missing angular wedge.",
    role: "limitation",
    marginLabel: "Caveat",
    provenance: paperProvenance(
      "prov-hl-limit-abstract",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-abstract",
        sectionTitle: "Abstract",
        page: 1,
        paragraphId: "chen-abstract-p2",
      },
      "Recovery remains orientation-dependent.",
    ),
  },
  {
    id: "hl-framing",
    paperId: selectedPaperId,
    sectionId: "chen-introduction",
    paragraphId: "chen-intro-p2",
    page: 2,
    text:
      "The practical question is whether anisotropic evidence is sufficient for a specified defect, depth, and orientation.",
    role: "definition",
    marginLabel: "Decision frame",
    provenance: paperProvenance(
      "prov-hl-framing",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-introduction",
        sectionTitle: "Why planar packages break the CT assumption",
        page: 2,
        paragraphId: "chen-intro-p2",
      },
      "Whether its anisotropic evidence is sufficient for a specified defect, depth, and orientation.",
    ),
  },
  {
    id: "hl-contribution",
    paperId: selectedPaperId,
    sectionId: "chen-introduction",
    paragraphId: "chen-intro-p3",
    page: 3,
    text:
      "A controlled reconstruction comparison on the same projections is paired with destructive cross-sections for 24 seeded sites.",
    role: "central-claim",
    marginLabel: "Contribution",
    provenance: paperProvenance(
      "prov-hl-contribution",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-introduction",
        sectionTitle: "Why planar packages break the CT assumption",
        page: 3,
        paragraphId: "chen-intro-p3",
      },
      "A controlled comparison on the same raw projections, paired with destructive cross-sections for 24 seeded defect sites.",
    ),
  },
  {
    id: "hl-ground-truth",
    paperId: selectedPaperId,
    sectionId: "chen-methods",
    paragraphId: "chen-method-p1",
    page: 3,
    text:
      "Cross-sections were registered after scanning and treated as reference labels within ±6 μm alignment tolerance.",
    role: "method",
    marginLabel: "Reference",
    provenance: paperProvenance(
      "prov-hl-ground-truth",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-methods",
        sectionTitle: "Acquisition geometry and reconstruction",
        page: 3,
        paragraphId: "chen-method-p1",
      },
      "Metallographic cross-sections were registered after scanning and treated as reference labels within an estimated ±6 μm alignment tolerance.",
    ),
  },
  {
    id: "hl-geometry",
    paperId: selectedPaperId,
    sectionId: "chen-methods",
    paragraphId: "chen-method-p2",
    page: 4,
    text: "The scan uses 240 projections around an axis tilted 35° from the detector normal.",
    role: "method",
    marginLabel: "Geometry",
    provenance: paperProvenance(
      "prov-hl-geometry",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-methods",
        sectionTitle: "Acquisition geometry and reconstruction",
        page: 4,
        paragraphId: "chen-method-p2",
        figureId: "fig-geometry",
        figureLabel: "Figure 2",
      },
      "240 projections over 360° around an axis tilted 35° from the detector normal.",
    ),
  },
  {
    id: "hl-baselines",
    paperId: selectedPaperId,
    sectionId: "chen-methods",
    paragraphId: "chen-method-p3",
    page: 5,
    text: "AA-PD is compared with FBP and isotropic TV on the identical raw projections.",
    role: "method",
    marginLabel: "Baselines",
    provenance: paperProvenance(
      "prov-hl-baselines",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-methods",
        sectionTitle: "Acquisition geometry and reconstruction",
        page: 5,
        paragraphId: "chen-method-p3",
      },
      "We compare Feldkamp-style filtered backprojection, isotropic total variation, and an angle-aware primal-dual reconstruction.",
    ),
  },
  {
    id: "hl-outcomes",
    paperId: selectedPaperId,
    sectionId: "chen-methods",
    paragraphId: "chen-method-p4",
    page: 6,
    text: "Primary outcomes are defect sensitivity, candidate-region false positives, and CNR.",
    role: "method",
    marginLabel: "Measures",
    provenance: paperProvenance(
      "prov-hl-outcomes",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-methods",
        sectionTitle: "Acquisition geometry and reconstruction",
        page: 6,
        paragraphId: "chen-method-p4",
      },
      "Primary outcomes are defect-level sensitivity, false-positive count, and contrast-to-noise ratio.",
    ),
  },
  {
    id: "hl-primary-result",
    paperId: selectedPaperId,
    sectionId: "chen-results",
    paragraphId: "chen-results-p1",
    page: 7,
    text: "AA-PD recovered 20/24 seeded voids; TV recovered 16/24 and FBP 11/24.",
    role: "result",
    marginLabel: "Primary result",
    provenance: paperProvenance(
      "prov-hl-primary-result",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-results",
        sectionTitle: "Defect visibility depends on orientation",
        page: 7,
        paragraphId: "chen-results-p1",
      },
      "AA-PD recovered 20 of 24 seeded voids, compared with 16 for TV and 11 for FBP.",
    ),
  },
  {
    id: "hl-cnr-result",
    paperId: selectedPaperId,
    sectionId: "chen-results",
    paragraphId: "chen-results-p2",
    page: 7,
    text: "Median CNR was 4.8 for AA-PD, 3.5 for TV, and 2.1 for FBP.",
    role: "result",
    marginLabel: "Effect size",
    provenance: paperProvenance(
      "prov-hl-cnr-result",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-results",
        sectionTitle: "Defect visibility depends on orientation",
        page: 7,
        paragraphId: "chen-results-p2",
      },
      "Median defect-region CNR was 4.8 for AA-PD, 3.5 for TV, and 2.1 for FBP.",
    ),
  },
  {
    id: "hl-orientation-result",
    paperId: selectedPaperId,
    sectionId: "chen-results",
    paragraphId: "chen-results-p3",
    page: 8,
    text: "Angle-aware regularization reduces streaks but cannot recover unmeasured boundary information.",
    role: "limitation",
    marginLabel: "Evidence limit",
    provenance: paperProvenance(
      "prov-hl-orientation-result",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-results",
        sectionTitle: "Defect visibility depends on orientation",
        page: 8,
        paragraphId: "chen-results-p3",
        figureId: "fig-results",
        figureLabel: "Figure 5",
      },
      "Angle-aware regularization reduced streak amplitude without recovering boundary information absent from the projections.",
    ),
  },
  {
    id: "hl-specificity-limit",
    paperId: selectedPaperId,
    sectionId: "chen-limitations",
    paragraphId: "chen-limit-p1",
    page: 9,
    text: "Candidate-region false positives are not a measure of full-volume specificity.",
    role: "limitation",
    marginLabel: "Validity",
    provenance: paperProvenance(
      "prov-hl-specificity-limit",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-limitations",
        sectionTitle: "Limits, transfer, and inspection claims",
        page: 9,
        paragraphId: "chen-limit-p1",
      },
      "The reported false-positive counts should not be interpreted as full-volume specificity.",
    ),
  },
  {
    id: "hl-throughput-limit",
    paperId: selectedPaperId,
    sectionId: "chen-limitations",
    paragraphId: "chen-limit-p2",
    page: 9,
    text: "The 14-minute acquisition and offline reconstruction do not support inline inspection claims.",
    role: "limitation",
    marginLabel: "Deployment gap",
    provenance: paperProvenance(
      "prov-hl-throughput-limit",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-limitations",
        sectionTitle: "Limits, transfer, and inspection claims",
        page: 9,
        paragraphId: "chen-limit-p2",
      },
      "The 14-minute scan and offline AA-PD reconstruction do not meet inline inspection requirements.",
    ),
  },
  {
    id: "hl-conclusion",
    paperId: selectedPaperId,
    sectionId: "chen-limitations",
    paragraphId: "chen-limit-p3",
    page: 10,
    text: "Reconstruction quality cannot turn an unobserved boundary into evidence.",
    role: "central-claim",
    marginLabel: "Takeaway",
    provenance: paperProvenance(
      "prov-hl-conclusion",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-limitations",
        sectionTitle: "Limits, transfer, and inspection claims",
        page: 10,
        paragraphId: "chen-limit-p3",
      },
      "Reconstruction quality alone cannot turn an unobserved boundary into evidence.",
    ),
  },
];

export const guidedPrompts: GuidedReadingPrompt[] = [
  {
    id: "prompt-frame-claim",
    stage: 1,
    stageTitle: "Frame the claim",
    stageEyebrow: "Stage 1 of 4",
    question:
      "What problem do the authors actually claim to solve—and what stronger problem might a quick reader mistakenly think they solved?",
    rationale:
      "Separating the stated scope from the tempting headline prevents a useful result from becoming an inflated conclusion.",
    cues: [
      "Name the specimen and defect classes.",
      "Distinguish physical access from reconstruction quality.",
      "Look for an explicit non-claim in the final sentence.",
    ],
    responsePlaceholder:
      "The paper addresses… It does not yet establish… The distinction matters because…",
    grounding: {
      paperId: selectedPaperId,
      sectionId: "chen-introduction",
      sectionTitle: "Why planar packages break the CT assumption",
      pageRange: [2, 3],
      paragraphId: "chen-intro-p3",
    },
    suggestedHighlightIds: ["hl-problem", "hl-framing", "hl-contribution"],
  },
  {
    id: "prompt-evaluate-evidence",
    stage: 2,
    stageTitle: "Evaluate the evidence",
    stageEyebrow: "Stage 2 of 4",
    question:
      "Which result most directly supports the central claim, and does the comparison isolate reconstruction quality from acquisition geometry?",
    rationale:
      "A persuasive image is not enough; the strongest evidence should match the claim and share a fair baseline.",
    cues: [
      "Check whether methods use the same raw projections.",
      "Prefer defect-level outcomes over visual impression alone.",
      "Record both the effect and the sample-size caveat.",
    ],
    responsePlaceholder:
      "The strongest evidence is… The baseline is fair/unfair because… My confidence is limited by…",
    grounding: {
      paperId: selectedPaperId,
      sectionId: "chen-results",
      sectionTitle: "Defect visibility depends on orientation",
      pageRange: [7, 8],
      figureId: "fig-results",
      figureLabel: "Figure 5",
    },
    suggestedHighlightIds: ["hl-baselines", "hl-primary-result", "hl-cnr-result"],
  },
  {
    id: "prompt-test-boundaries",
    stage: 3,
    stageTitle: "Test the boundaries",
    stageEyebrow: "Stage 3 of 4",
    question:
      "Under which defect orientations, materials, and operating conditions should you expect this result to fail or become ambiguous?",
    rationale:
      "A method becomes actionable only when its blind spots are attached to the contexts that trigger them.",
    cues: [
      "Trace the missing wedge to the bridge result.",
      "Separate seeded voids from natural defects.",
      "Do not convert candidate-region scoring into specificity.",
    ],
    responsePlaceholder:
      "The result is least reliable when… The paper tests/does not test… I would verify…",
    grounding: {
      paperId: selectedPaperId,
      sectionId: "chen-limitations",
      sectionTitle: "Limits, transfer, and inspection claims",
      page: 9,
      paragraphId: "chen-limit-p1",
    },
    suggestedHighlightIds: [
      "hl-orientation-result",
      "hl-specificity-limit",
      "hl-throughput-limit",
    ],
  },
  {
    id: "prompt-synthesize-next",
    stage: 4,
    stageTitle: "Synthesize the next move",
    stageEyebrow: "Stage 4 of 4",
    question:
      "What bounded claim can enter your literature review now, and what single follow-up source would most reduce uncertainty?",
    rationale:
      "A defensible review preserves what is known, why it is credible, and the exact question that remains open.",
    cues: [
      "Write one claim with specimen and geometry qualifiers.",
      "Attach a page or figure, not just the paper title.",
      "Choose a follow-up that tests transfer or ground truth.",
    ],
    responsePlaceholder:
      "Bounded claim: … Supported by… Next I need a source that…",
    grounding: {
      paperId: selectedPaperId,
      sectionId: "chen-limitations",
      sectionTitle: "Limits, transfer, and inspection claims",
      page: 10,
      paragraphId: "chen-limit-p3",
    },
    suggestedHighlightIds: ["hl-primary-result", "hl-orientation-result", "hl-conclusion"],
  },
];

export const seededNotes: EvidenceNote[] = [
  {
    id: "note-defect-recovery",
    paperId: selectedPaperId,
    title: "Angle-aware reconstruction improves seeded-void recovery",
    kind: "direct-evidence",
    claim:
      "For this 35° laminography scan and test vehicle, AA-PD recovers more seeded underfill voids than TV or FBP.",
    evidence:
      "AA-PD detected 20/24 sites, versus 16/24 for TV and 11/24 for FBP; the methods used the same 240 projections.",
    interpretation:
      "The controlled input makes reconstruction method a plausible explanation for the difference, but the small, seeded set limits precision and transfer.",
    openQuestion:
      "Does the advantage persist for irregular natural voids in copper-dense production packages?",
    confidence: "high",
    status: "verified",
    reviewedAt: "2026-08-28T13:14:00.000Z",
    provenance: paperProvenance(
      "prov-note-defect-recovery",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-results",
        sectionTitle: "Defect visibility depends on orientation",
        page: 7,
        paragraphId: "chen-results-p1",
      },
      "AA-PD recovered 20 of 24 seeded voids, compared with 16 for TV and 11 for FBP.",
    ),
    linkedHighlightIds: ["hl-baselines", "hl-primary-result"],
    collectionIds: ["collection-advanced-packaging", "collection-literature-review"],
    tags: ["defect sensitivity", "baseline comparison"],
    revision: { rootId: "note-defect-recovery", number: 1, isLatest: true },
    createdAt: "2026-08-28T13:08:00.000Z",
    updatedAt: "2026-08-28T13:14:00.000Z",
  },
  {
    id: "note-orientation-boundary",
    paperId: selectedPaperId,
    title: "Missing-wedge orientation remains a hard evidence boundary",
    kind: "interpretation",
    claim:
      "Angle-aware regularization mitigates artifacts but does not make defect visibility orientation-invariant.",
    evidence:
      "Figure 5 and the bridge experiment show elongation when the bridge lies within 12° of the least-supported direction.",
    interpretation:
      "A reconstruction may look cleaner while still lacking boundary information; inspection claims need an orientation qualifier.",
    openQuestion:
      "Could a complementary second tilt close the blind direction within an acceptable scan-time budget?",
    confidence: "high",
    status: "verified",
    reviewedAt: "2026-08-28T13:22:00.000Z",
    provenance: paperProvenance(
      "prov-note-orientation-boundary",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-results",
        sectionTitle: "Defect visibility depends on orientation",
        page: 8,
        paragraphId: "chen-results-p3",
        figureId: "fig-results",
        figureLabel: "Figure 5",
      },
      "Angle-aware regularization reduced streak amplitude without recovering boundary information absent from the projections.",
    ),
    linkedHighlightIds: ["hl-orientation-result", "hl-conclusion"],
    collectionIds: ["collection-inspection-methods", "collection-literature-review"],
    tags: ["missing wedge", "orientation", "artifact"],
    revision: { rootId: "note-orientation-boundary", number: 1, isLatest: true },
    createdAt: "2026-08-28T13:22:00.000Z",
    updatedAt: "2026-08-28T13:22:00.000Z",
  },
  {
    id: "note-specificity-question",
    paperId: selectedPaperId,
    title: "Full-volume false-positive rate is unresolved",
    kind: "open-question",
    claim:
      "The study does not establish full-volume specificity for package inspection.",
    evidence:
      "Reviewers scored only registered candidate regions, and the authors explicitly warn against interpreting those false positives as specificity.",
    interpretation:
      "A production inspection case needs a search-task evaluation with normal background regions, not only known defect sites.",
    openQuestion:
      "What false-alarm rate appears when blinded reviewers search an entire unregistered package volume?",
    confidence: "high",
    status: "needs-verification",
    provenance: paperProvenance(
      "prov-note-specificity-question",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-limitations",
        sectionTitle: "Limits, transfer, and inspection claims",
        page: 9,
        paragraphId: "chen-limit-p1",
      },
      "The reported false-positive counts should not be interpreted as full-volume specificity.",
    ),
    linkedHighlightIds: ["hl-outcomes", "hl-specificity-limit"],
    collectionIds: ["collection-literature-review"],
    tags: ["specificity", "validation", "open question"],
    revision: { rootId: "note-specificity-question", number: 1, isLatest: true },
    createdAt: "2026-08-28T13:31:00.000Z",
    updatedAt: "2026-08-28T13:31:00.000Z",
  },
  {
    id: "note-throughput-scope",
    paperId: selectedPaperId,
    title: "Evidence supports failure analysis, not inline deployment",
    kind: "direct-evidence",
    claim:
      "The demonstrated workflow is currently scoped to failure analysis or process development rather than inline inspection.",
    evidence:
      "Acquisition requires 14 minutes, reconstruction is offline, and the authors explicitly withhold inline-inspection claims.",
    interpretation:
      "Throughput should be treated as a separate design axis from defect visibility in the review matrix.",
    openQuestion:
      "Which acquisition or reconstruction shortcut dominates the sensitivity loss when total cycle time is reduced below two minutes?",
    confidence: "high",
    status: "verified",
    reviewedAt: "2026-08-28T13:36:00.000Z",
    provenance: paperProvenance(
      "prov-note-throughput-scope",
      selectedPaper,
      {
        paperId: selectedPaperId,
        sectionId: "chen-limitations",
        sectionTitle: "Limits, transfer, and inspection claims",
        page: 9,
        paragraphId: "chen-limit-p2",
      },
      "The 14-minute scan and offline AA-PD reconstruction do not meet inline inspection requirements.",
    ),
    linkedHighlightIds: ["hl-throughput-limit"],
    collectionIds: ["collection-advanced-packaging"],
    tags: ["throughput", "deployment scope"],
    revision: { rootId: "note-throughput-scope", number: 1, isLatest: true },
    createdAt: "2026-08-28T13:36:00.000Z",
    updatedAt: "2026-08-28T13:36:00.000Z",
  },
];

export const collections: Collection[] = [
  {
    id: "collection-advanced-packaging",
    name: "Advanced Packaging",
    description: "Package architectures, buried interconnect defects, and practical inspection constraints.",
    color: "blue",
    paperIds: ["chen-2024-laminography", "kim-2020-tsv-synchrotron"],
    noteIds: ["note-defect-recovery", "note-throughput-scope"],
    evidenceClaimCount: 2,
    openQuestionCount: 2,
    updatedAt: "2026-08-28T13:36:00.000Z",
  },
  {
    id: "collection-inspection-methods",
    name: "Inspection Methods",
    description: "Acquisition geometries, reconstruction baselines, validation designs, and blind spots.",
    color: "teal",
    paperIds: [
      "chen-2024-laminography",
      "silva-2022-artifact-aware",
      "bauer-2021-planar-electronics",
      "patel-2024-uncertainty-ct",
    ],
    noteIds: ["note-orientation-boundary"],
    evidenceClaimCount: 1,
    openQuestionCount: 1,
    updatedAt: "2026-08-28T13:22:00.000Z",
  },
  {
    id: "collection-literature-review",
    name: "Literature Review — Draft",
    description: "Evidence-backed statements ready to organize into the review, plus unresolved checks.",
    color: "amber",
    paperIds: [
      "chen-2024-laminography",
      "okafor-2023-primal-dual",
      "bauer-2021-planar-electronics",
    ],
    noteIds: ["note-defect-recovery", "note-orientation-boundary", "note-specificity-question"],
    evidenceClaimCount: 2,
    openQuestionCount: 3,
    updatedAt: "2026-08-28T13:31:00.000Z",
  },
];

export const recentActivity: ResearchActivity[] = [
  {
    id: "activity-specificity",
    type: "question-flagged",
    title: "Flagged a validation gap",
    detail: "Full-volume specificity still needs a source with a blinded search task.",
    occurredAt: "2026-08-28T13:31:00.000Z",
    paperId: selectedPaperId,
    noteId: "note-specificity-question",
    locator: {
      paperId: selectedPaperId,
      sectionId: "chen-limitations",
      sectionTitle: "Limits, transfer, and inspection claims",
      page: 9,
    },
  },
  {
    id: "activity-figure-linked",
    type: "evidence-linked",
    title: "Linked Figure 5 to an interpretation",
    detail: "Missing-wedge orientation remains visible despite reduced streaking.",
    occurredAt: "2026-08-28T13:22:00.000Z",
    paperId: selectedPaperId,
    noteId: "note-orientation-boundary",
    locator: {
      paperId: selectedPaperId,
      sectionId: "chen-results",
      sectionTitle: "Defect visibility depends on orientation",
      page: 8,
      figureId: "fig-results",
      figureLabel: "Figure 5",
    },
  },
  {
    id: "activity-note-saved",
    type: "note-saved",
    title: "Saved an evidence-backed claim",
    detail: "Recorded the 20/24 versus 16/24 versus 11/24 defect-recovery result.",
    occurredAt: "2026-08-28T13:14:00.000Z",
    paperId: selectedPaperId,
    noteId: "note-defect-recovery",
    locator: {
      paperId: selectedPaperId,
      sectionId: "chen-results",
      sectionTitle: "Defect visibility depends on orientation",
      page: 7,
    },
  },
  {
    id: "activity-resumed",
    type: "paper-opened",
    title: "Resumed guided reading",
    detail: "Continued at Stage 2 — Evaluate the evidence.",
    occurredAt: "2026-08-28T12:54:00.000Z",
    paperId: selectedPaperId,
    locator: {
      paperId: selectedPaperId,
      sectionId: "chen-results",
      sectionTitle: "Defect visibility depends on orientation",
      page: 7,
    },
  },
];

export const dashboardMetrics: DashboardMetric[] = [
  {
    id: "papers-reviewed",
    label: "Papers reviewed",
    value: 1,
    detail: "of 6 in this research trail",
    trend: "1 active reading",
  },
  {
    id: "evidence-notes",
    label: "Evidence-backed notes",
    value: 4,
    detail: "all linked to a page or figure",
    trend: "+3 today",
  },
  {
    id: "open-questions",
    label: "Open questions",
    value: 3,
    detail: "awaiting another source",
    trend: "1 high priority",
  },
];

export const connectedTools: ConnectedResearchTool[] = [
  {
    id: "tool-literature-index",
    name: "Literature search",
    kind: "literature-search",
    status: "demo-ready",
    statusLabel: "Seeded demo",
    description: "Typed search results with provider and retrieval provenance.",
    transport: "mock",
    lastCheckedAt: DEMO_RETRIEVED_AT,
  },
  {
    id: "tool-paper-source",
    name: "Paper source",
    kind: "paper-source",
    status: "demo-ready",
    statusLabel: "Seeded demo",
    description: "Sections, figures, and locators from the bundled reader corpus.",
    transport: "mock",
    lastCheckedAt: DEMO_RETRIEVED_AT,
  },
  {
    id: "tool-zotero",
    name: "Citation library",
    kind: "citation-library",
    status: "not-connected",
    statusLabel: "MCP available",
    description: "Ready for a governed Zotero or reference-manager adapter.",
    transport: "mcp",
  },
  {
    id: "tool-notes",
    name: "Research notes",
    kind: "notes",
    status: "not-connected",
    statusLabel: "WebMCP available",
    description: "Can sync structured notes without exposing an unrestricted workspace.",
    transport: "webmcp",
  },
  {
    id: "tool-evidence-store",
    name: "Evidence store",
    kind: "evidence-store",
    status: "demo-ready",
    statusLabel: "Local demo",
    description: "In-memory claims remain bound to immutable provenance records.",
    transport: "mock",
    lastCheckedAt: DEMO_RETRIEVED_AT,
  },
];

export function getPaperById(paperId: string): Paper | undefined {
  return papers.find((paper) => paper.id === paperId);
}

export function getSectionsForPaper(paperId: string): PaperSection[] {
  return paperSections.filter((section) => section.paperId === paperId);
}

export function getFiguresForPaper(paperId: string): PaperFigure[] {
  return paperFigures.filter((figure) => figure.paperId === paperId);
}

export function getHighlightsForPaper(paperId: string): PaperHighlight[] {
  return paperHighlights.filter((highlight) => highlight.paperId === paperId);
}

export function getNotesForPaper(paperId: string): EvidenceNote[] {
  return seededNotes.filter((note) => note.paperId === paperId);
}

export function getCollectionById(collectionId: string): Collection | undefined {
  return collections.find((collection) => collection.id === collectionId);
}

// Upper-case aliases make the seed constants convenient in non-React modules.
export const CURRENT_RESEARCH_GOAL = researchGoal;
export const PAPERS = papers;
export const SELECTED_PAPER_ID = selectedPaperId;
export const SELECTED_PAPER = selectedPaper;
export const PAPER_SECTIONS = paperSections;
export const PAPER_FIGURES = paperFigures;
export const PAPER_HIGHLIGHTS = paperHighlights;
export const GUIDED_PROMPTS = guidedPrompts;
export const SEEDED_NOTES = seededNotes;
export const COLLECTIONS = collections;
export const RECENT_ACTIVITY = recentActivity;
export const DASHBOARD_METRICS = dashboardMetrics;
export const CONNECTED_TOOLS = connectedTools;
