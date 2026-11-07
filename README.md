# Referensys for Windows

Records a procedure as you do it. Every click in any program (Chrome, Edge, desktop software, anything) becomes a step with a screenshot, an orange ring where you clicked, a title such as *Click "Verify"* and written instructions. Then you cover personal details, check the wording and save it to your Google Drive, where you can search, open and rename it from any computer.

Recordings stay on your computer until you save. When you save, Referensys uploads only the redacted screenshots, to a **Referensys SOPs** folder in your own Google Drive. It can only see files it created there, nothing else in your Drive. It also checks GitHub for new versions of itself.

## Install

1. Double-click **Referensys-Setup-1.2.0.exe**.
2. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**. This appears because the app isn't from a registered publisher.
3. Referensys installs and opens. You'll find it on your desktop and in the Start menu.

## Updates

Referensys updates itself. Each time it opens (and every 4 hours while it's open), it checks for a newer version and downloads it in the background. When one is ready, a bar says **Update ready**:

- **Restart and update** installs it now. Save your work first.
- **Later** installs it the next time you close Referensys.

Referensys checks when it opens and every 4 hours. To check right away, open **Settings** and click **Check for updates**, which also shows download progress.

You never need to download Referensys again.

## Recording

1. Click **Record → My screen**. Referensys hides and a small bar appears in the top-right corner.
2. Do the task as you normally would, in any program. Every left click adds a step.
3. Use **Pause** on the bar for clicks you don't want recorded, then **Resume**. Click **Done** when finished.
4. Go through each step: drag **Redact** boxes over personal details, check the title and instructions, and tick the privacy check.
5. Click **Save to Drive**. The first time, Google asks you to sign in and click **Allow**. The SOP is saved as one PDF in **Referensys SOPs** in your Google Drive.

After that first save, **changes save automatically**. A few seconds after you stop editing, Referensys updates the same PDF in Drive. The status next to **Library** shows *Saving soon…* and then *Saved to Drive*. Autosave waits while a step's privacy check is unticked, while you're recording, or while you're signed in to a different Google account than the SOP is in. Click the status to see why. Referensys also finishes any pending save before it closes.

That PDF opens like any other PDF, and it also carries the editable steps inside, so Referensys can open it again for editing. Referensys's search list is kept in a hidden folder that only Referensys can see, so your Drive folder shows just your SOPs.

You can also click **Export PDF** to save the PDF on this computer. It carries the editable steps too: open it with **Library → Open a file from this PC**.

The small bar doesn't appear in your screenshots.

## Your SOP library

Click **Library** to see every SOP in your Referensys SOPs folder, newest first.

- **Search** looks through titles, departments, step titles and instructions, and shows the step that matched.
- **Open** loads an SOP back into the editor. Change anything, then **Save to Drive** again to update the same file.
- **PDF** opens the PDF in Google Drive, ready to print or share.
- **Rename** changes the file's name in Drive.

Any Google account works, including Gmail. Open **Settings** (top right) to add another account, switch which Drive you save to, or sign out. Each account has its own library.

## Good to know

- **Titles and instructions are written for you** from the name of what you clicked, for example *In Outlook, click the "Send" button.* Edit them as needed. Once you edit the instructions, Referensys won't overwrite them.
- **Check the text for personal details.** Titles and instructions are plain text and can't be redacted like a screenshot. Referensys leaves out names in "Last, First" form, dates, long numbers and email addresses, but always read them before ticking the privacy check. To stop using on-screen text altogether, untick **Use button and field names in step titles** in the Record menu.
- Text you type into fields is never used in titles.
- Some programs don't share button names with Windows. Those steps get a title like *Click in ProgramName* for you to edit.
- If a program runs **as administrator**, Windows won't let Referensys see clicks inside it. Right-click Referensys and choose **Run as administrator** to record it.
- **Sample app** in the Record menu (also linked from the start screen) is a built-in app with fake data for practicing.
- **Redaction boxes become permanent in Drive.** While an SOP is open you can still move or delete boxes, but the copy in Drive always has them burned in, and the unredacted screenshots are never uploaded. After you reopen an SOP, its boxes can't be removed. To fix one, replace that step.
- Saving is blocked until every step has passed the privacy check.
- If Google Drive can't be reached, Referensys offers to save a copy to this PC. Open it later with **Library → Open a file from this PC**.
- To uninstall: **Settings → Apps → Installed apps → Referensys → Uninstall**.
