import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// The server runs on one thread: a synchronous process call holds every
// request, stream and agent until the command ends. Commands go through a
// CommandRunner (platform/process/command-runner.ts), which awaits them.
const SYNC_PROCESS_MESSAGE = "The server must not wait on a command: run it through a CommandRunner (platform/process/command-runner.ts).";
const SYNC_PROCESS_CALLS = [
  // A default import reaches the same functions as a member (cp.spawnSync).
  ...["node:child_process", "child_process"].map((name) => ({
    name,
    importNames: ["default", "spawnSync", "execSync", "execFileSync"],
    message: SYNC_PROCESS_MESSAGE
  })),
  { name: "bun", importNames: ["spawnSync"], message: SYNC_PROCESS_MESSAGE }
];

// A matcher that fails on a DOM node prints the node, and with it the whole
// document it hangs in: one failing assertion has written logs of 100 MB to
// 2 GB. Lint has no types here, so these are the direct forms: a node read
// (querySelector, querySelectorAll, closest, getElementById, activeElement,
// bare or behind !, ?. or as) handed to expect, then a matcher whose failure
// prints it. .not.toBeNull(), toHaveLength and reads such as ?.textContent or
// getAttribute(...) stay allowed.
const DOM_MATCHER_MESSAGE = "A DOM node in a matcher prints the whole document when it fails: assert a boolean, a count or a read instead (=== null, .length, ?.textContent, getAttribute).";
const DOM_READ = "/^(querySelector|querySelectorAll|closest|getElementById)$/";
const domNodeAt = (path) => [
  `[${path}.callee.property.name=${DOM_READ}]`,
  `[${path}.expression.callee.property.name=${DOM_READ}]`,
  `[${path}.property.name='activeElement']`,
  `[${path}.expression.property.name='activeElement']`
];
const DOM_NODE_IN_MATCHER = [
  ...domNodeAt("callee.object.arguments.0").map((node) =>
    `CallExpression[callee.property.name=/^(toBeNull|toBe|toBeUndefined|toBeFalsy|toBeTruthy|toEqual|toStrictEqual)$/][callee.object.callee.name='expect']${node}`),
  // Negated, a matcher fails on the node itself, and prints it; against null
  // (.not.toBe(null), as .not.toBeNull()) it fails only when there is none.
  ...domNodeAt("callee.object.object.arguments.0").map((node) =>
    `CallExpression[callee.property.name=/^(toBe|toBeTruthy|toEqual|toStrictEqual)$/][callee.object.property.name='not'][callee.object.object.callee.name='expect']${node}:not([arguments.0.raw='null'])`)
].map((selector) => ({ selector, message: DOM_MATCHER_MESSAGE }));

export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/target/**", "src/client/components/ui/**", "e2e/.artifacts/**"]
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...tsPlugin.configs["recommended"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-explicit-any": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  },
  {
    files: ["src/server/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: SYNC_PROCESS_CALLS }],
      // Whatever the object (Bun, a namespace import, a required module), and
      // however it is reached in ordinary code: a member, a literal index, a
      // destructured name. A name built at run time is not looked for.
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[property.name=/^(spawnSync|execSync|execFileSync)$/]",
        message: SYNC_PROCESS_MESSAGE
      }, {
        selector: "MemberExpression[computed=true][property.value=/^(spawnSync|execSync|execFileSync)$/]",
        message: SYNC_PROCESS_MESSAGE
      }, {
        selector: "ObjectPattern > Property[key.name=/^(spawnSync|execSync|execFileSync)$/]",
        message: SYNC_PROCESS_MESSAGE
      }]
    }
  },
  {
    files: ["src/server/platform/**/*.ts"],
    rules: {
      // platform/ is the server's bottom layer (sqlite, tmux, git, fs, time,
      // errors). It must not reach up into modules/, runtime/ or app/, even
      // for a type: whatever platform needs from above is passed in (see
      // SchemaContributor in platform/db/schema.ts). Matching is on the
      // relative specifier, so it covers static imports and re-exports, not
      // dynamic import().
      "no-restricted-imports": ["error", {
        // Flat config replaces a rule's options per file: the server-wide
        // ban on synchronous process calls is restated here.
        paths: SYNC_PROCESS_CALLS,
        patterns: [{
          regex: "^(\\.\\./)+(modules|runtime|app)(/|$)",
          message: "platform/ is the bottom layer: pass what it needs in from app/ instead of importing modules/, runtime/ or app/."
        }]
      }]
    }
  },
  {
    files: [
      "src/client/components/QuestionCallout.tsx",
      "src/client/hooks/useTerminalSession.ts",
      "src/client/routes/terminals/WindowDetailPage.tsx",
      "src/client/routes/settings/MemoryPane.tsx",
      "src/client/routes/settings/useProviderCards.ts",
      "src/client/routes/settings/settings-config.ts",
      "src/client/routes/settings/SettingsConfigProvider.tsx",
      "src/client/routes/settings/SettingsPage.tsx",
      "src/client/routes/settings/SkillsPane.tsx",
      "src/client/routes/terminal/LiveTerminal.tsx",
      "src/client/routes/terminal/TerminalPage.tsx",
      "src/client/routes/window/chat/ChatMessageList.tsx",
      "src/client/routes/window/WindowPage.tsx",
      "src/client/shell/ConnectionIndicator.tsx"
    ],
    rules: {
      // React Hooks v7 currently reports intentional route-load and UI reset
      // effects in these existing components. Keep the exception local so new
      // files still get the rule.
      "react-hooks/set-state-in-effect": "off"
    }
  },
  {
    files: [
      "src/client/routes/settings/MemoryPane.tsx",
      "src/client/routes/settings/settings-config.ts",
      "src/client/routes/terminal/LiveTerminal.tsx"
    ],
    rules: {
      // The refs rule misclassifies the object returned by useTerminalSession
      // as a React ref throughout LiveTerminal's render, and flags the
      // intentional latest-value refs (ref.current assigned during render) in
      // MemoryPane and useSaveUnit. Keep this narrow so new files still get
      // the rule.
      "react-hooks/refs": "off"
    }
  },
  {
    files: ["src/client/routes/terminals/PaneRowList.tsx"],
    rules: {
      // PaneRowList deliberately ships its row-data mappers next to the
      // component so every consumer (the Window page, the terminal's pane
      // switcher, tests) imports one path. Re-exporting from a helper module
      // trips the rule just the same, so the exception is the honest fix.
      // Keep it to this file so new files still get the rule.
      "react-refresh/only-export-components": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx", "e2e/**/*.ts"],
    rules: {
      // Tests use loose mock payloads and fixture dispatchers extensively;
      // keeping no-explicit-any enabled there creates churn without improving
      // product type boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      // Component tests use probe components that intentionally capture hook
      // results into module-level variables for assertions.
      "react-hooks/globals": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...DOM_NODE_IN_MATCHER]
    }
  },
  {
    files: ["e2e/**/*.ts"],
    rules: {
      // Bun's expect(promise).resolves/.rejects runs the event loop inside the
      // matcher and holds queued immediates, so Playwright delivers an event
      // before the object it names ("Object with guid … was not bound in the
      // connection"). Await first: expect(await promise).
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[property.name=/^(resolves|rejects)$/][object.type='CallExpression'][object.callee.name='expect']",
        message: "In e2e write expect(await promise): Bun's .resolves/.rejects reorders Playwright's messages."
      }]
    }
  }
];
