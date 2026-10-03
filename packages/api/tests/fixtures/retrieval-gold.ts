/**
 * Gold-question relevance fixtures for S13 retrieval.
 *
 * Synthetic corpus and questions only: each project holds one document whose
 * chunks are plain strings, and `retrieval.test.ts` embeds them with the
 * deterministic `termVector` helper. Each project carries several realistic
 * distractor chunks beside the single gold chunk, so the corpus is larger
 * than the requested top-k and the gold chunk has to beat them on relevance
 * — a case names the chunk that actually answers the question, not merely a
 * chunk from the right document.
 */

export type GoldProject = {
  name: string;
  /** One document: the gold chunk first, followed by topical distractors. */
  documents: Array<{ filename: string; chunks: string[] }>;
};

export type GoldQuestion = {
  id: string;
  question: string;
  project: string;
  document: string;
  /** Exact text of the chunk that must rank first for this question. */
  chunk: string;
};

export const goldCorpus: GoldProject[] = [
  {
    name: "Biology",
    documents: [
      {
        filename: "photosynthesis.md",
        chunks: [
          "Photosynthesis converts sunlight into chemical energy that plant cells store as glucose.",
          "Chlorophyll in leaves absorbs red and blue light while reflecting green wavelengths.",
          "The Calvin cycle fixes carbon dioxide into sugar using energy carried by ATP.",
          "Chemical energy stored in sugar bonds is released step by step as cells respire.",
          "Photosynthesis in a dry spell slows when the stomata close and carbon dioxide runs short.",
          "Sunlight drives the electron transport chain across the thylakoid membrane.",
          "Mitochondria release stored energy from glucose during cellular respiration.",
          "Root hairs absorb dissolved minerals from the soil solution by active transport.",
        ],
      },
    ],
  },
  {
    name: "History",
    documents: [
      {
        filename: "europe.md",
        chunks: [
          "The Peace of Westphalia treaty ended the Thirty Years' War in 1648 and affirmed state sovereignty.",
          "A later peace treaty ended a shorter border war in the Low Countries during 1648.",
          "The Congress of Vienna redrew the map of Europe after the Napoleonic Wars in 1815.",
          "The Treaty of Versailles imposed heavy reparations on Germany after the First World War.",
          "Merchants in the Baltic watched the war end while their grain ships sailed on untouched.",
          "Nationalist movements pressed for self rule across the Balkans before the Great War.",
          "The Diet of Worms placed a reforming monk under an imperial ban in 1521.",
          "Feudal lords collected rent from peasants who worked the land under a manor court.",
        ],
      },
    ],
  },
  {
    name: "Programming",
    documents: [
      {
        filename: "python.md",
        chunks: [
          "Python decorators wrap a function so extra behaviour runs before and after each call without editing the function body.",
          "A Python package exposes a function from its top level so imports stay short and stable.",
          "Registering a callback makes a framework call your function once a request finishes.",
          "A hash map computes an index from each key to deliver average constant-time lookup.",
          "Thread pools reuse a fixed set of workers to amortise the cost of task switches.",
          "Function annotations describe argument types for readers and for static checkers.",
          "A context manager guarantees that files are closed even when an exception propagates.",
          "List comprehensions build a new list by filtering and transforming an existing one.",
        ],
      },
    ],
  },
];

export const goldQuestions: GoldQuestion[] = [
  {
    id: "photosynthesis-energy",
    question: "How does photosynthesis convert sunlight into chemical energy?",
    project: "Biology",
    document: "photosynthesis.md",
    chunk: "Photosynthesis converts sunlight into chemical energy that plant cells store as glucose.",
  },
  {
    id: "thirty-years-war",
    question: "Which treaty ended the Thirty Years' War in Europe?",
    project: "History",
    document: "europe.md",
    chunk: "The Peace of Westphalia treaty ended the Thirty Years' War in 1648 and affirmed state sovereignty.",
  },
  {
    id: "python-decorators",
    question: "What do Python decorators do to a function?",
    project: "Programming",
    document: "python.md",
    chunk: "Python decorators wrap a function so extra behaviour runs before and after each call without editing the function body.",
  },
];
