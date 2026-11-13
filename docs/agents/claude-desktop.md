<script setup>
import { VPButton } from 'vitepress/theme';
</script>

# Set up the Claude desktop app

For the **Chat** and **Cowork** tabs of the Claude app on your Mac or PC. Using Claude Code instead? See [Claude Code](./claude-code).

## 1. Download and open

<VPButton href="https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb" text="Download ZynoHosting for Claude" />

**Double-click the downloaded file.** Claude opens an install window. Click **Install**.

The window offers to limit ZynoHosting to particular folders. **Leave that empty**, so you can publish any folder and add new sites later without changing settings.

You don't need to install anything else. Claude keeps ZynoHosting up to date for you.

## 2. Check it worked

Click the **+** button beside the message box, hover **Connectors**, and choose **Manage connectors**. ZynoHosting should be listed.

If it isn't, quit Claude completely (not just the window), reopen it, and look again.

## 3. Sign in

Copy this into a new chat:

```text:no-line-numbers
Sign in to ZynoHosting. Ask only for the permissions this task needs. If my browser can't open the sign-in page, give me a link and a code instead and wait while I approve it. Tell me which account and organization you signed in to, and confirm the sign-in worked before continuing.
```

A sign-in page opens in your browser. Sign in as usual, read what you are allowing, and approve it. You stay signed in: the extension keeps its sign-in renewed in your computer's password store, until the access time you choose on the approval page ends.

## 4. Start working

Go to [What to ask your agent](./prompts).

In Chat, always tell Claude **which folder** your site is in, because a chat has no project open. To copy a folder's path: on a Mac, right-click it in Finder, hold **Option**, and choose **Copy "folder" as Pathname**. On Windows, hold **Shift**, right-click, and choose **Copy as path**, then remove the quotation marks.

## If something goes wrong

| What you see                                   | What to do                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude says it has no ZynoHosting tools        | Quit Claude completely and reopen it. Still missing? Download and install again.                                                            |
| Claude offers to set ZynoHosting up itself     | It can't from a chat. Use the download above.                                                                                               |
| ZynoHosting says the extension must be updated | Download and install again, then restart Claude. It normally updates itself, so something blocked the update.                               |
| It says a folder is not allowed                | You limited it to folders during install. Open Settings → Extensions → ZynoHosting, add the folder or clear the list, and restart.          |
| The sign-in page never opened                  | Ask: _Give me the ZynoHosting sign-in link._ Links expire after five minutes.                                                               |
| Zyno staff testing alpha or dev                | Set Environment in Settings → Extensions → ZynoHosting to `alpha` or `dev`, restart, and sign in again. Leave it as `production` otherwise. |
| An error you don't understand                  | Paste it back and ask: _Explain this in plain language and tell me what to do next._                                                        |
