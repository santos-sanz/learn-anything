import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInForm } from "../src/SignInForm.js";

test("the sign-in form renders labelled credentials fields and the recovery gap", () => {
  const html = renderToStaticMarkup(<SignInForm busy={false} error={null} onSubmit={() => undefined} />);
  expect(html).toContain('id="auth-email"');
  expect(html).toContain('type="password"');
  expect(html).toContain("<label for=\"auth-email\">Email</label>");
  expect(html).toContain("Password recovery is not available in this build");
  expect(html).not.toContain('role="alert"');
});

test("a sign-in error is announced and the busy state disables the form", () => {
  const html = renderToStaticMarkup(<SignInForm busy={true} error={"Email or password is incorrect."} onSubmit={() => undefined} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Email or password is incorrect.");
  expect(html).toContain("disabled");
});
