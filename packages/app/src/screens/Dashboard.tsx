import { useState } from "react";

import { ConfirmDelete } from "../components/ConfirmDelete.js";
import { useProjects } from "../data/ProjectsProvider.js";
import type { ProjectSummary } from "../data/projects.js";
import { serializeRoute } from "../router.js";
import { mapDataError, modeLabel } from "../view.js";

/**
 * Project dashboard: owned projects only (the backend re-derives the owner),
 * with actionable loading, empty, error and delete-confirmation states.
 */
export function Dashboard() {
  const { state, reload, remove } = useProjects();
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (pendingDelete === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await remove(pendingDelete.id);
      setPendingDelete(null);
    } catch (caught) {
      setDeleteError(mapDataError(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const cancelDelete = () => {
    if (deleteBusy) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  return (
    <section className="screen" aria-labelledby="dashboard-heading">
      <div className="screen-header">
        <h1 id="dashboard-heading">Your projects</h1>
        <a className="button button-primary" href="#/projects/new">
          New project
        </a>
      </div>

      {state.status === "loading" && (
        <p className="state-block" role="status">
          Loading your projects…
        </p>
      )}

      {state.status === "error" && (
        <div className="state-block" role="alert">
          <p>Couldn’t load your projects.</p>
          <button type="button" className="button button-primary" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && state.projects.length === 0 && (
        <div className="state-block onboarding">
          <h2>Create your first project</h2>
          <p>A project holds your learning goal and everything you study. Pick a mode to get started — you can change it later.</p>
          <a className="button button-primary" href="#/projects/new">
            Start your first project
          </a>
        </div>
      )}

      {state.status === "ready" && state.projects.length > 0 && (
        <ul className="project-grid">
          {state.projects.map((project) => {
            const label = modeLabel(project.mode);
            return (
              <li key={project.id}>
                <article className="card">
                  <h2 className="card-title">{project.name}</h2>
                  {label !== null && <p className="badge">{label}</p>}
                  {project.goal !== undefined && <p className="card-goal">{project.goal}</p>}
                  <div className="card-actions">
                    <a className="button" href={serializeRoute({ name: "project", id: project.id })} aria-label={`Open ${project.name}`}>
                      Open
                    </a>
                    <button
                      type="button"
                      className="button button-danger"
                      aria-label={`Delete ${project.name}`}
                      onClick={() => {
                        setDeleteError(null);
                        setPendingDelete(project);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDelete open={pendingDelete !== null} projectName={pendingDelete?.name ?? ""} busy={deleteBusy} error={deleteError} onCancel={cancelDelete} onConfirm={handleDelete} />
    </section>
  );
}
