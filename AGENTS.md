# Template-first coordination

The in-app template maker is the authoring surface for every coordination method.

- Make behavior changes in the template whenever its existing building blocks can express them.
- If the maker cannot express a required behavior, extend the shared template model, validator, executor, and visual controls first. Then compose the behavior in the template.
- Every shipped template must be recreatable from a new method in the visual maker. Copying a built-in or editing JSON cannot be the only way to obtain a capability.
- Expose the full customization available to shipped templates, including stage prompts, settings, workflow branches, response contracts, roles, routing, memory, and run controls. Do not offer controls the executor ignores.
- Keep host operations as reusable, validated building blocks for mechanical work such as citation checks, ledger updates, ranking, and workspace isolation. Stage order and completion policy belong in template data; do not inject hidden stages from a report or finalizer.
- When adding a template capability, verify visual authoring, saved-definition round trips, and execution. Keep existing user changes intact.
