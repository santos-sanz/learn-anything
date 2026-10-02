import { useState, type FormEvent } from "react";

export type SignInSubmission = {
  flow: "signIn" | "signUp";
  email: string;
  password: string;
};

export type SignInFormProps = {
  busy: boolean;
  error: string | null;
  onSubmit: (submission: SignInSubmission) => void | Promise<void>;
};

/**
 * Minimal Convex Auth password sign-in. Password recovery and email
 * verification are intentionally absent: they need an email provider this
 * build does not configure (docs/adr/0004), and the gap is stated in the UI
 * instead of being hidden.
 */
export function SignInForm({ busy, error, onSubmit }: SignInFormProps) {
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit({ flow, email, password });
  };

  return (
    <main>
      <h1>Learn Anything</h1>
      <form onSubmit={handleSubmit}>
        <fieldset disabled={busy}>
          <legend>{flow === "signIn" ? "Sign in" : "Create account"}</legend>
          <p>
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </p>
          <p>
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" name="password" type="password" autoComplete={flow === "signIn" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
          </p>
          <p>
            <button type="submit">{flow === "signIn" ? "Sign in" : "Create account"}</button>
            <button
              type="button"
              onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}
            >
              {flow === "signIn" ? "Create an account instead" : "Sign in instead"}
            </button>
          </p>
        </fieldset>
        {error !== null && <p role="alert">{error}</p>}
        <p>Password recovery is not available in this build; it needs an email provider.</p>
      </form>
    </main>
  );
}
