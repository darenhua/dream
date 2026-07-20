import { useEffect, useState } from "react";
import { MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { AdminDashboard } from "./components/AdminDashboard";
import { OrganizedFeed } from "./screens/OrganizedFeed";
import "./index.css";

// View shell: the organized feed IS the dashboard now; admin is a mode.
export function App() {
  const [admin, setAdmin] = useState(false);
  const [tick, setTick] = useState(0); // bumped after any mutation to refresh
  const bump = () => setTick(t => t + 1);

  useEffect(() => {
    api.visit().catch(() => {}); // the glance ping
  }, []);

  const logo = (
    <button className="flex items-center gap-2" onClick={() => setAdmin(false)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <MoonStar className="size-5" />
      </span>
      <span className="font-semibold">dream coach</span>
      <Badge
        className={
          admin
            ? "border-transparent bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
            : "border-transparent bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
        }
      >
        {admin ? "admin" : "user"}
      </Badge>
    </button>
  );

  const modeToggle = (
    <div className="flex items-center gap-2">
      <Label htmlFor="mode-toggle" className="text-sm">
        {admin ? "user toggle" : "admin toggle"}
      </Label>
      <Switch id="mode-toggle" checked={admin} onCheckedChange={setAdmin} />
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 md:pb-8">
      <header className="mb-6 flex items-center justify-between gap-4 border-b py-3">
        {logo}
        <div className="flex items-center gap-4">{modeToggle}</div>
      </header>

      <main>
        {admin ? <AdminDashboard onChanged={bump} /> : <OrganizedFeed tick={tick} onChanged={bump} />}
      </main>
    </div>
  );
}

export default App;
