import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getCurrentUser, isAuthenticated } from "@/lib/auth";
import { getDefaultRouteForUser } from "@/lib/permissions";

export function UnauthorizedPage({ title = "Access Denied" }: { title?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = getCurrentUser();
  const loggedIn = isAuthenticated();
  const fallback = useMemo(() => (loggedIn ? getDefaultRouteForUser(user) : "/login"), [loggedIn, user]);
  const [seconds, setSeconds] = useState(8);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (seconds > 0) return;
    navigate(fallback, { replace: true, state: { from: location.pathname } });
  }, [seconds, fallback, navigate, location.pathname]);

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="mx-auto max-w-2xl rounded-2xl border border-border/40 bg-card/80 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You are not authorized to view this page. You will be redirected in {seconds}s.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link to={fallback} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Go to authorized page
          </Link>
          <Link to="/login" className="rounded-lg border border-border px-4 py-2 text-sm text-foreground">
            Go to login
          </Link>
        </div>
      </div>
    </div>
  );
}
