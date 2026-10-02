import { useCallback, useEffect, useState } from "react";

import { ConfirmDelete } from "../components/ConfirmDelete.js";
import { ProjectForm } from "../components/ProjectForm.js";
import { useProjects } from "../data/ProjectsProvider.js";
import type { ProjectSummary } from "../data/projects.js";
import { navigate } from "../router.js";
import { dataErrorCode, mapDataError, modeLabel, toFormValues, toPatch, type ProjectFormValues } from "../view.js";

type DetailState = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; project: ProjectSummary };

/** Project detail: read one owned project, edit goal/mode/name, delete with confirmation. */
export function ProjectDetail({ id }: { id: string }) {
  const { get, update, remove } = useProjects();
  const [detail, setDetail] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetail({ status: "loading" });
    get(id)
      .then((project) => {
        if (active) setDetail({ status: "ready", project });
      })
      .catch((caught: unknown) => {
        if (active) setDetail({ status: "error", error: caught });
      });
    return () => {
      active = false;
    };
  }, [get, id, attempt]);

  const handleSave = useCallback(
    async (values: ProjectFormValues) => {
      setSaveBusy(true);
      setSaveError(null);
      setSaved(false);
      const patch = toPatch(values);
      try {
        await update(id, patch);
        setDetail((previous) => {
          if (previous.status !== "ready") return previous;
          const project: ProjectSummary = {
            ...previous.project,
            name: patch.name,
            goal: patch.goal === "" ? undefined : patch.goal,
            mode: patch.mode ?? previous.project.mode,
          };
          return { status: "ready", project };
        });
        setSaved(true);
      } catch (caught) {
        setSaveError(mapDataError(caught));
      } finally {
        setSaveBusy(false);
      }
    },
    [id, update],
  );

  const handleDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await remove(id);
      setDeleteOpen(false);
      navigate({ name: "dashboard" });
    } catch (caught) {
      setDeleteError(mapDataError(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  const cancelDelete = () => {
    if (deleteBusy) return;
    setDeleteOpen(false);
    setDeleteError(null);
  };

  if (detail.status === "loading") {
    return (
      <section className="screen">
        <h1>Project</h1>
        <p className="state-block" role="status">
          Loading project…
        </p>
      </section>
    );
  }

  if (detail.status === "error") {
    const notFound = dataErrorCode(detail.error) === "NOT_FOUND";
    return (
      <section className="screen">
        <h1>Project</h1>
        <div className="state-block" role="alert">
          <p>{mapDataError(detail.error, "project")}</p>
          <p className="state-actions">
            {!notFound && (
              <button type="button" className="button button-primary" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            )}
            <a className="button" href="#/projects">
              Back to your projects
            </a>
          </p>
        </div>
      </section>
    );
  }

  const { project } = detail;
  const label = modeLabel(project.mode);

  return (
    <section className="screen" aria-labelledby="project-heading">
      <div className="screen-header">
        <h1 id="project-heading">{project.name}</h1>
        <a className="button" href="#/projects">
          Back to projects
        </a>
      </div>

      <div className="project-summary">
        {label !== null && <p className="badge">{label}</p>}
        {project.goal !== undefined && <p className="card-goal">{project.goal}</p>}
      </div>

      <h2>Edit project</h2>
      <ProjectForm initialValues={toFormValues(project)} submitLabel="Save changes" busy={saveBusy} error={saveError} requireMode={false} onSubmit={(values) => void handleSave(values)} />
      {saved && (
        <p className="form-success" role="status">
          Changes saved.
        </p>
      )}

      <section className="danger-zone" aria-labelledby="delete-project-heading">
        <h2 id="delete-project-heading">Delete project</h2>
        <p className="screen-intro">Deleting removes this project and everything inside it. This can’t be undone.</p>
        <button
          type="button"
          className="button button-danger"
          onClick={() => {
            setDeleteError(null);
            setDeleteOpen(true);
          }}
        >
          Delete this project
        </button>
      </section>

      <ConfirmDelete open={deleteOpen} projectName={project.name} busy={deleteBusy} error={deleteError} onCancel={cancelDelete} onConfirm={handleDelete} />
    </section>
  );
}
