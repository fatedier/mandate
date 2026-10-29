import { expect, test } from "bun:test";
import { remoteWebBase } from "../src/shared/git-web.js";

test("a remote becomes the web address of its repository", () => {
  expect(remoteWebBase("git@github.com:acmecorp/project-1.git")).toBe("https://github.com/acmecorp/project-1");
  expect(remoteWebBase("https://github.com/acmecorp/project-1.git")).toBe("https://github.com/acmecorp/project-1");
  expect(remoteWebBase("https://github.com/acmecorp/project-1")).toBe("https://github.com/acmecorp/project-1");
  expect(remoteWebBase("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("https://gitlab.example.com/team/app");
  // A web port is part of the address; an ssh port is not the web's.
  expect(remoteWebBase("https://git.example.com:8443/team/app.git")).toBe("https://git.example.com:8443/team/app");
  // A trailing slash after .git is still the same repository.
  expect(remoteWebBase("https://github.com/acmecorp/project-1.git/")).toBe("https://github.com/acmecorp/project-1");
  expect(remoteWebBase("git@github.com:acmecorp/project-1.git/")).toBe("https://github.com/acmecorp/project-1");
  expect(remoteWebBase("/srv/git/app.git")).toBe(null);
  expect(remoteWebBase(null)).toBe(null);
});
