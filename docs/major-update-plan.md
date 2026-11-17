# Camel Studio: plan for the major update

Written 2026-11-13 from the seven requests and a study of Kaoto's documentation.
Status: plan only. Nothing in this document is built yet.

## What was asked

1. An admin area for the tool itself: JDK, Maven and Camel versions, new components, custom processes.
2. Java classes as the output instead of YAML routes, selectable, following the team's project template (sample to come).
3. Study Kaoto and adopt what is useful.
4. A data mapper like Kaoto's and TIBCO's: connect one schema to another, better if possible.
5. Simpler handling of connectors, global variables, process variables and expressions.
6. Test connection for connectors.
7. More graphical detail editing, and a VS Code extension.

## What Kaoto does, and what we take from it

Kaoto is Red Hat's open source (Apache 2.0) visual designer for Camel. It edits YAML routes only; it has no Java output, no admin area, no run-time tracing on the canvas and no test-connection. Where it is ahead of Camel Studio today:

| Kaoto feature | What it does | Decision |
|---|---|---|
| DataMapper | Source and target schema trees (XSD, JSON Schema); drag a field onto a field; lines; auto-map containers by name; for-each, if, choose; variables; XPath editor with a searchable function catalogue. Generates XSLT 3.0. | Build our own on the same model, plus live preview with sample data (Kaoto has none) |
| Beans editor | Define a bean (for example a DataSource) once, pick it from a dropdown in any step, or create it from that dropdown | Adopt as "Connections", and add Test connection |
| Node actions | Replace, enable/disable, copy/paste across routes, drag to reorder and to move between containers, right-click menu | Adopt all |
| Route documentation | Generates Markdown documentation for selected routes | Adopt |
| Runtime selector | Switch Camel catalog version; custom catalog URL | Adopt inside the admin area |
| Custom Kamelets | A file in the workspace becomes a palette entry | Adopt as the team palette |
| REST editor | Design REST APIs, or import OpenAPI | Later |
| Infrastructure view | Start Kafka, databases and brokers locally with one click (needs Docker) | Later |
| Citrus tests | Visual end-to-end tests | Later |

Sources: [Kaoto documentation](https://kaoto.io/docs/), [DataMapper: creating mappings](https://kaoto.io/docs/datamapper/03-creating-mappings/), [attaching schemas](https://kaoto.io/docs/datamapper/02-attaching-schemas/), [conditional mappings](https://kaoto.io/docs/datamapper/04-conditional-mappings/), [XPath editor](https://kaoto.io/docs/datamapper/07-xpath-editor/), [working with nodes](https://kaoto.io/docs/designer/02-working-with-nodes/), [runtime selector](https://kaoto.io/docs/designer/04-runtime-selector/), [beans](https://kaoto.io/docs/beans/).

## Design for each request

### 1. Admin area

A Settings area in the app, backed by one file (`~/.camel-studio/settings.json`) that can be exported as a **team profile** and kept in Git, so every developer gets the same setup.

- **Toolchain**: registered JDKs and Maven installs, the default for new projects, `settings.xml`, corporate repository mirror.
- **Versions**: download and switch Camel catalogs (several side by side), with the matching Spring Boot version.
- **Team palette**: custom components (imported from a JAR's own Camel descriptor, or described by hand) and custom steps with typed options and an icon.
- **Reusable processes**: a group of steps saved as one palette entry.
- **Project templates**: the skeleton used by New project.

Open question: is a Settings area enough, or must it be locked so only certain people can change it?

### 2. Java classes as output

Recommended approach: the visual model stays the source of truth, and Camel Studio **generates** the Java class from it through a template.

- Each project chooses its output: YAML DSL or Java DSL.
- The model file lives in the project (outside the classpath); the generated class carries a "generated" header.
- Hand-written code goes in marked regions, or in separate classes the route calls, so it survives regeneration.
- Tracing and breakpoints keep working, because the generator knows which line each step lands on.

Reading arbitrary hand-written Java back into the designer is not planned: it cannot be made reliable. Existing Java routes stay viewable read-only.

Blocked on: the sample of the team's template.

### 3. Data mapper

- Source tree (body, headers, variables) on the left, target tree on the right, lines between them.
- Schemas: XSD and JSON Schema first; a sample XML or JSON document as a shortcut when there is no schema.
- Drag field to field; drag container to container to auto-map by name.
- For-each, if, choose-when-otherwise, copy, constants.
- Formula editor with a function catalogue and drag-in fields.
- **Live preview**: paste or pick a sample input, see the output update. This is what TIBCO's mapper tester gave and Kaoto lacks.
- Output: XSLT 3.0 run by Camel's Saxon component, the same choice Kaoto made.

Open question: are the team's messages mostly XML, JSON, or Java objects? Java-object mapping would need a different generator.

### 4. Variables and expressions

- **Global variables** (BW5 gvars): one table per environment, stored as Spring properties, with secrets marked. Used anywhere through a picker, never typed by hand.
- **Process variables**: Camel exchange variables, shown as a list per route with where each is set and read.
- **Expression builder** replacing the free-text box: pick from body fields, headers, variables and global variables; functions from a list; the result shown as readable chips.
- **Try it**: evaluate an expression against a message already captured in the Trace tab.

### 5. Connections and test connection

- Shared connections defined once per project (database, JMS, Kafka, HTTP, FTP/SFTP, LDAP, SMPP) and picked from a dropdown in steps.
- **Test** button, in two levels: can the host and port be reached; then a real login using the project's own drivers.

### 6. More graphical details

- Purpose-built editors instead of generic forms: condition builder for Choice, header and property tables, endpoint builder with separate path parts, SQL editor with parameters, timer and cron builder, route picker for `direct:` calls.
- Right-click menu, drag to reorder, replace, disable, copy and paste.

### 7. VS Code extension

The UI already talks to the disk only through one bridge, so the same UI can run inside a VS Code custom editor with a second implementation of that bridge. Planned after the features above so both shells get them.

## Proposed order

| Phase | Contents | Depends on |
|---|---|---|
| A | Admin area, version manager, team palette, node actions (replace, disable, copy/paste, drag, right-click) | nothing |
| B | Global and process variables, expression builder, connections with Test connection | A |
| C | Data mapper with live preview | B (uses the expression builder) |
| D | Java class generation from the team template | the template sample |
| E | VS Code extension | A to D |

Phase D moves to the front as soon as the sample arrives, because it changes what every other phase writes to disk.

The deploy-and-monitor phase is paused. Research so far: a deployed app can report health, route status, route statistics and JVM metrics over HTTP (Spring Boot Actuator with Camel's endpoints), and accept route start and stop.

## Needed from the team

1. The Java template sample.
2. What "custom processes" means in practice: reusable groups of steps, custom Java processors, or both.
3. Whether the admin area needs access control.
4. Message formats to map: XML, JSON, Java objects.
5. The connection types that matter most for Test connection.
