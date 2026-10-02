import { useState } from "react";

import { ProjectForm } from "../components/ProjectForm.js";
import { useProjects } from "../data/ProjectsProvider.js";
import { navigate } from "../router.js";
import { mapDataError, toDraft, type ProjectFormValues } from "../view.js";

/**
 * Create screen, doubling as guided onboarding when the learner has no
 * projects yet: the first-run copy explains the goal/mode choice up front.
 */
export function NewProject() {
  const { state, create } = useProjects();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstProject = state.status === "ready" && state.projects.length === 0;

  const handleSubmit = async (values: ProjectFormValues) => {
    setBusy(true);
    setError(null);
    try {
      const id = await create(toDraft(values));
      navigate({ name: "project", id });
    } catch (caught) {
      setError(mapDataError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="screen" aria-labelledby="new-project-heading">
      <div className="screen-header">
        <h1 id="new-project-heading">{isFirstProject ? "Set up your first project" : "Create a project"}</h1>
      </div>
      {isFirstProject && <p className="screen-intro">Tell us what you want to learn. Your goal and mode shape how the tutor helps you — both stay editable.</p>}
      <ProjectForm submitLabel="Create project" busy={busy} error={error} requireMode onSubmit={(values) => void handleSubmit(values)} onCancel={() => navigate({ name: "dashboard" })} />
    </section>
  );
}
