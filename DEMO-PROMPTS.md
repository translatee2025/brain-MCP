# Brain MCP — demo prompts

Three prompts that exercise the connector end to end after install. They work
against the bundled sample vault (`samples/brain-sample.zip`) or your own notes.

### 1. Load the sample vault and explore it

> Import the notes from `samples/brain-sample.zip` into Brain, then list what
> folders and notes I now have.

Exercises `brain_import` then `brain_list`. You should see Projects/Modem,
Personal, and Tech with a few notes each.

### 2. Recall something specific

> Search my Brain for what I decided about the car, then show me that note in
> full.

Exercises `brain_search` then `brain_get`. Returns the "Car buying notes"
note (white car, cooler and easier to resell).

### 3. Save a new note, safely

> Remember this for later: my staging deploy token is
> `ghp_AbCdEf0123456789AbCdEf0123456789abcd` and the deploy runs every Friday.
> Save it to Brain under DevOps.

Exercises `brain_save` with secret redaction. The note is created under
DevOps, the schedule is kept, and the token is replaced with a
`<redacted:github_token#...>` placeholder before anything is written to disk.
The reply notes that 1 secret was redacted.

### Bonus: open the viewer

> Open the Brain web viewer.

Exercises `brain_open_ui`. Opens a localhost-only page (the URL carries a
one-time token) to browse, edit, restore versions, and download notes.
