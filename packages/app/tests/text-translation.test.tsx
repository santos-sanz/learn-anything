// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { TurnCapturePanel } from "../src/TurnCapturePanel.js";
import { requestAudioTranslation, requestTextTranslation, type AudioTranslationResult } from "../src/translationClient.js";
import {
  initialTextTranslationState,
  reduceTextTranslation,
  type TranslationLanguage,
} from "../src/translationState.js";
import type { TurnAction } from "../src/turnState.js";

afterEach(cleanup);

type HarnessProps = {
  initialAction: TurnAction | null;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  audioFetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** Wires the real panel to the real reducers and clients with an injected fetch. */
function Harness({ initialAction, fetchImpl, audioFetchImpl }: HarnessProps) {
  const [textTranslation, dispatch] = useReducer(reduceTextTranslation, undefined, initialTextTranslationState);
  const [action, setAction] = useState<TurnAction | null>(initialAction);
  const [target, setTarget] = useState<TranslationLanguage>("en");
  const [, setAudioResult] = useState<AudioTranslationResult | null>(null);

  const translateText = (): void => {
    dispatch({ type: "REQUEST" });
    void requestTextTranslation({
      siteUrl: "https://test-convex.example",
      token: "session-token",
      projectId: "p1",
      text: textTranslation.original,
      source: textTranslation.source,
      target,
      fetchImpl,
    }).then((result) => {
      if (result.ok) {
        dispatch({ type: "SUCCEEDED", target: result.target, translation: result.translation, unchanged: result.unchanged });
      } else {
        dispatch({ type: "FAILED", code: result.code, retryAfterMs: result.retryAfterMs });
      }
    });
  };

  const translateAudio = (): void => {
    void requestAudioTranslation({
      siteUrl: "https://test-convex.example",
      token: "session-token",
      projectId: "p1",
      turnId: "turn-1",
      target,
      audio: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
      fetchImpl: audioFetchImpl ?? fetchImpl,
    }).then(setAudioResult);
  };

  return (
    <TurnCapturePanel
      state={{ phase: "idle" }}
      action={action}
      onActionChange={setAction}
      language="en"
      onLanguageChange={() => undefined}
      target={target}
      onTargetChange={setTarget}
      onStart={translateAudio}
      onStop={() => undefined}
      onCancel={() => undefined}
      onEditTranscript={() => undefined}
      textTranslation={textTranslation}
      onEditSourceText={(text) => dispatch({ type: "EDIT_ORIGINAL", text })}
      onSourceLanguageChange={(source) => dispatch({ type: "SET_SOURCE", source })}
      onTranslateText={translateText}
      onClearTranslation={() => dispatch({ type: "CLEAR_RESULT" })}
    />
  );
}

test("a completed text translation keeps the original text on screen beside it", async () => {
  const user = userEvent.setup();
  const fetchImpl = vi.fn(async () =>
    Response.json({ source: "es", target: "en", translation: "The library is closed.", unchanged: false }),
  );

  render(<Harness initialAction="translate-text" fetchImpl={fetchImpl} />);

  await user.selectOptions(screen.getByLabelText("Source language"), "es");
  await user.type(screen.getByLabelText(/Original text/), "La biblioteca está cerrada.");

  const translateButton = screen.getByRole("button", { name: "Translate text" });
  expect((translateButton as HTMLButtonElement).disabled).toBe(false);
  await user.click(translateButton);

  const original = (await screen.findByLabelText(/Original text/)) as HTMLTextAreaElement;
  expect(original.value).toBe("La biblioteca está cerrada."); // never replaced by the translation

  const group = screen.getByRole("group", { name: /^Translation/ });
  expect(within(group).getByText("The library is closed.")).toBeTruthy();
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Clear translation" }));
  expect(within(screen.getByRole("group", { name: /^Translation/ })).queryByText("The library is closed.")).toBeNull();
  expect((screen.getByLabelText(/Original text/) as HTMLTextAreaElement).value).toBe(
    "La biblioteca está cerrada.",
  );
});

test("an unsupported audio translation target switches the learner to text translation", async () => {
  const user = userEvent.setup();
  const fetchImpl = vi.fn(async () => Response.json({}));

  render(<Harness initialAction="translate-audio" fetchImpl={fetchImpl} />);

  await user.selectOptions(screen.getByLabelText("Target language"), "es");
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Audio translation to Spanish is not supported");
  expect(alert.textContent).toContain("only produces English");
  expect(screen.queryByRole("button", { name: /Record audio to translate/ })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Translate the text instead" }));
  expect((screen.getByRole("radio", { name: /Translate text/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByLabelText(/Original text/)).toBeTruthy();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("a rejected language pair renders actionable copy instead of an English answer", async () => {
  const user = userEvent.setup();
  const fetchImpl = vi.fn(async () =>
    Response.json({ code: "UNSUPPORTED_LANGUAGE_PAIR", supportedLanguages: ["en", "es"] }, { status: 422 }),
  );

  render(<Harness initialAction="translate-text" fetchImpl={fetchImpl} />);
  await user.selectOptions(screen.getByLabelText("Target language"), "es");
  await user.type(screen.getByLabelText(/Original text/), "Bonjour tout le monde");
  await user.click(screen.getByRole("button", { name: "Translate text" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("That language pair is not supported");
  expect(alert.textContent).toContain("English or Spanish");
  expect(screen.getByRole("group", { name: /^Translation/ }).textContent).not.toContain("Bonjour");
});
