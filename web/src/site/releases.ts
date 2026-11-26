// Every release, newest first. The hero pill and the "what's new" section both
// read the first entry, so shipping a release means adding one entry at the top.

export type Release = {
  version: string;
  date: string; // yyyy-mm-dd
  title: string;
  summary: string;
  points: string[];
  cmd: string;
};

export const RELEASES: Release[] = [
  {
    version: '0.4.0',
    date: '2026-11-26',
    title: 'Real bugs, real fixes, real track records',
    summary: 'Plant the defects agents actually ship. Hand agents structured findings and let only crossexam close them. Build a picture of which agent you can trust, from evidence.',
    points: ['behavioural mutations: auth, transactions, retries, boundaries, concurrency', 'findings sessions and crossexam reverify', 'crossexam reliability: three measures per agent, never blended'],
    cmd: 'npx crossexamdev reliability',
  },
  {
    version: '0.3.0',
    date: '2026-11-19',
    title: 'Test strength',
    summary: 'crossexam mutate plants small defects in the lines a change touched and reports which ones your tests missed, inside a sandbox or not at all.',
    points: ['crossexam mutate and verify --mutate', 'sandboxed with bwrap, sandbox-exec or docker', 'assess_test_strength in the MCP server'],
    cmd: 'npx crossexamdev mutate',
  },
  {
    version: '0.2.0',
    date: '2026-11-04',
    title: 'First release on npm',
    summary: 'Check what any coding agent claims against what actually ran: the CLI, the MCP server and the GitHub Action.',
    points: ['crossexam verify and scan', 'MCP server for any agent', 'GitHub Action for pull requests'],
    cmd: 'npx crossexamdev scan',
  },
];

export const LATEST = RELEASES[0];

export const releaseDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
