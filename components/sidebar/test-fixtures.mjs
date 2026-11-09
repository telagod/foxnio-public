/** Row factories and an action recorder shared by the sidebar component tests. */

let counter = 0;

export const section = (id, overrides = {}) => ({
  kind: "section",
  key: `section:${id}`,
  section: id,
  count: 2,
  collapsed: false,
  collapsible: id !== "workspaces",
  ...overrides,
});

export const group = (name, overrides = {}) => ({
  kind: "group",
  key: `group:${name}`,
  projectKey: `/work/${name}`,
  path: `/work/${name}`,
  label: name,
  alias: undefined,
  expanded: true,
  selected: false,
  pinned: false,
  hasLaunchConfig: false,
  counts: { total: 3, running: 0, waiting: 0, unread: 0, exited: 0 },
  canMoveUp: false,
  canMoveDown: false,
  index: 0,
  setSize: 1,
  ...overrides,
});

export const session = (id, overrides = {}) => ({
  kind: "session",
  key: `${overrides.context ?? "tree"}:${id}`,
  sessionId: id,
  projectKey: "/work/app",
  depth: 0,
  status: "idle",
  title: `Title ${id}`,
  timestamp: new Date(Date.now() - 150 * 60_000).toISOString(),
  worktreeBranch: undefined,
  selected: false,
  pinned: false,
  hasChildren: false,
  expanded: false,
  context: "tree",
  workspaceLabel: undefined,
  snippet: undefined,
  optimistic: false,
  ...overrides,
});

export const more = (overrides = {}) => ({
  kind: "more",
  key: `more:${counter++}`,
  projectKey: "/work/app",
  hidden: 7,
  canCollapse: false,
  ...overrides,
});

export const placeholder = (variant, overrides = {}) => ({
  kind: "placeholder",
  key: `placeholder:${variant}:${counter++}`,
  variant,
  projectKey: undefined,
  detail: undefined,
  ...overrides,
});

/** A SidebarActions stand-in that records `[method, ...args]` for every call. */
export function createActions() {
  const calls = [];
  const actions = new Proxy({}, {
    get: (_target, name) => (typeof name === "string" ? (...args) => void calls.push([name, ...args]) : undefined),
  });
  return { actions, calls };
}

export const viewProps = (overrides = {}) => {
  const { actions } = createActions();
  return {
    rows: [],
    density: "comfortable",
    actions,
    selectedRowIndex: null,
    search: { query: "", searching: false },
    filters: { sortMode: "none", runningOnly: false, recentRunsLimit: 10 },
    onOpenSettings: () => {},
    ...overrides,
  };
};
