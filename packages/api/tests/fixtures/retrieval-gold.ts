/**
 * Gold-question relevance fixtures for S13 retrieval.
 *
 * Synthetic corpus and questions only: each project holds one document whose
 * chunks are plain strings, and `retrieval.test.ts` embeds them with the
 * deterministic `termVector` helper. A case names the chunk that a relevance
 * assertion expects inside the returned top-k — the chunk that actually
 * answers the question, not merely a chunk from the right document.
 */

export type GoldProject = {
  name: string;
  documents: Array<{ filename: string; chunks: string[] }>;
};

export type GoldQuestion = {
  id: string;
  question: string;
  project: string;
  document: string;
  /** Exact text of the chunk expected within top-k for this question. */
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
          "The Congress of Vienna redrew the map of Europe after the Napoleonic Wars in 1815.",
          "The Treaty of Versailles imposed heavy reparations on Germany after the First World War.",
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
          "A hash map computes an index from each key to deliver average constant-time lookup.",
          "Garbage collection reclaims memory from objects that no live reference can reach.",
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
