# Camel Studio for VS Code

The Camel Studio designer inside VS Code. Open any `*.camel.yaml` route file and it opens on the
canvas, with the same palette, property forms, Data Mapper, global variables, Test connection,
Run, Debug, Trace and Build package as the desktop app.

- **Your file stays a VS Code document.** Edits on the canvas show in the tab as unsaved changes;
  save with ⌘S / Ctrl+S or File › Save. Typing in the text editor, reverting or pulling with Git
  updates the canvas.
- **Text when you want it.** The editor title has *Open as Text*; a text editor of a route file
  has *Open in Camel Studio Designer*. To make text the default, use *Reopen Editor With…* and
  *Configure default editor*.
- **New route file**: right-click a folder in the Explorer, or run *Camel Studio: New Route File*.
- **Java projects.** In a project that saves routes as Java classes, the route files under
  `src/main/camel-studio` open in the designer and the `RouteBuilder` class is regenerated on
  every save, as in the desktop app.
- **Shared settings.** JDK, Maven, the Camel version, the team palette and team components are
  the same settings the desktop app uses (`~/.camel-studio`). The gear in the designer opens them.

Git is left to VS Code's own Source Control view.

Requires a JDK and Maven to run routes; Settings can install both.
