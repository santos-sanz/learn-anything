/**
 * Synthetic concept corpus and graded reply fixtures for the S20 offline
 * tests. Every document, chunk and feedback string here is invented for the
 * fixture: no provider, embedding or network call exists on this path, and
 * `concept.test.ts` seeds the chunks with the deterministic `termVector`
 * helper the retrieval suite already uses.
 */

export type CorpusChunk = { text: string; heading?: string; page?: number };
export type CorpusDocument = { filename: string; chunks: CorpusChunk[] };

/** Two small concept documents: the corpus the retrieval tests ground on. */
export const conceptCorpus: CorpusDocument[] = [
  {
    filename: "photosynthesis.md",
    chunks: [
      {
        text: "Photosynthesis converts sunlight into chemical energy stored in glucose.",
        heading: "Biology > Photosynthesis",
      },
      {
        text: "The light-dependent reactions take place in the thylakoid membrane, where water is split and oxygen is released.",
        heading: "Biology > Photosynthesis",
      },
    ],
  },
  {
    filename: "respiration.md",
    chunks: [{ text: "Cellular respiration releases energy from glucose inside the mitochondria.", page: 2 }],
  },
];

/**
 * Mock provider replies for teach-back and quiz grading: one per explicit
 * outcome, plus a lecture-only reply (no question, no verdict) that the
 * question-first guard must reject.
 */
export const gradedReplies = {
  correct:
    "Your explanation matches the notes: sunlight becomes chemical energy stored in glucose [1].\nVerdict: correct.\n\nWhat would happen if the light-dependent reactions stopped?",
  partiallyCorrect:
    "You captured the conversion but not where the energy ends up [1].\nVerdict: partially-correct.\n\nWhere in the plant cell is that energy stored?",
  wrong:
    "That is not what these documents say: they describe sunlight becoming chemical energy in glucose, not heat [1].\nVerdict: wrong.\n\nWhich line of the notes supports your answer?",
  uncertain:
    "Your project documents do not cover this, so I cannot check your answer.\nVerdict: uncertain.\n\nWhat in the notes made you think that?",
  questionFirst:
    "Before I explain anything: what do you already know about how plants capture sunlight?",
  lecture:
    "Photosynthesis is the process by which plants convert light energy into chemical energy. It takes place in the chloroplast and produces glucose for the plant to use.",
};
