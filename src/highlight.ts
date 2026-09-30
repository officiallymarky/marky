import bash from "refractor/bash";
import c from "refractor/c";
import cpp from "refractor/cpp";
import css from "refractor/css";
import diff from "refractor/diff";
import docker from "refractor/docker";
import go from "refractor/go";
import graphql from "refractor/graphql";
import ini from "refractor/ini";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import jsx from "refractor/jsx";
import markdown from "refractor/markdown";
import mermaid from "refractor/mermaid";
import markup from "refractor/markup";
import python from "refractor/python";
import rust from "refractor/rust";
import sql from "refractor/sql";
import toml from "refractor/toml";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

/** Languages registered for code-fence syntax highlighting. */
export const codeLanguages = [
  bash,
  c,
  cpp,
  css,
  diff,
  docker,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  jsx,
  markdown,
  mermaid,
  markup,
  python,
  rust,
  sql,
  toml,
  tsx,
  typescript,
  yaml,
];

/** Fence-language aliases (e.g. `py` → python) mapped to registered ids. */
export const codeLanguageAliases: Record<string, string[]> = {
  bash: ["sh", "shell", "zsh"],
  cpp: ["c++"],
  docker: ["dockerfile", "containerfile"],
  go: ["golang"],
  javascript: ["js"],
  json: ["jsonc"],
  markup: ["html", "xml", "svg"],
  python: ["py"],
  rust: ["rs"],
  typescript: ["ts"],
  yaml: ["yml"],
};
