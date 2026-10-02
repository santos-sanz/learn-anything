import { api } from "@learn-anything/api/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

export type ProjectPickerProps = {
  selectedProjectId: string | null;
  onSelect: (projectId: string) => void;
};

/**
 * Minimal project scope glue for S15: the microphone turn must target an
 * owned project, and the full dashboard is S21's story.
 */
export function ProjectPicker({ selectedProjectId, onSelect }: ProjectPickerProps) {
  const projects = useQuery(api.projects.listProjects, {});
  const createProject = useMutation(api.projects.createProject);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(null);
    try {
      const projectId = await createProject({ name: trimmed });
      setName("");
      onSelect(projectId);
    } catch {
      setError("The project could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (projects === undefined) return <p role="status">Loading projects…</p>;

  return (
    <section aria-label="Practice project">
      <p>
        <label htmlFor="project-picker">Project</label>
        <select
          id="project-picker"
          value={selectedProjectId ?? ""}
          onChange={(event) => onSelect(event.target.value)}
          disabled={projects.length === 0}
        >
          {projects.length === 0 && <option value="">No project yet</option>}
          {projects.map((project) => (
            <option key={project._id} value={project._id}>
              {project.name}
            </option>
          ))}
        </select>
      </p>
      <form onSubmit={(event) => void handleCreate(event)}>
        <fieldset disabled={busy}>
          <legend>New project</legend>
          <p>
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              name="name"
              type="text"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </p>
          <p>
            <button type="submit">Create project</button>
          </p>
        </fieldset>
        {error !== null && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
