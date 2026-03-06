import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "@/lib/auth";

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setError("");
    setIsSubmitting(true);
    const user = await login(email, password);
    setIsSubmitting(false);
    if (!user) {
      setError("Invalid credentials or suspended user.");
      return;
    }
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl border border-border/40 bg-card/80 p-6 space-y-4">
        <h1 className="text-2xl font-semibold text-foreground">Sign In</h1>
        <p className="text-sm text-muted-foreground">Use your dashboard user credentials.</p>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg bg-background/70 border border-border px-3 py-2"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg bg-background/70 border border-border px-3 py-2"
          required
        />
        {error && <div className="text-sm text-destructive">{error}</div>}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-primary text-primary-foreground py-2 font-medium disabled:opacity-60"
        >
          {isSubmitting ? "Signing in..." : "Login"}
        </button>
      </form>
    </div>
  );
}
