package dev.yarvis.android.api

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class WorkspacesClientTest {
    private val server = MockWebServer()
    private var prompts = 0
    private lateinit var client: YarvisClient

    @Before
    fun setUp() {
        server.start()
        client = YarvisClient(server.url("/"), "tok-123", testHttp) {
            prompts++
            null
        }
    }

    @After
    fun tearDown() = server.close()

    private fun bodyOf(request: mockwebserver3.RecordedRequest) = Json.parseToJsonElement(request.text)

    private val workspaceId = "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"

    @Test
    fun `the list asks for badges and decodes PR rows`() = runTest {
        server.enqueue(
            json(
                200,
                """[{"id":"$workspaceId","name":"Fix login","slug":"fix-login","status":"active","rootPath":"/w/fix-login",
                    "summary":null,"mergedPrUrl":null,"error":null,"archivedAt":null,"createdAt":"2026-11-20T10:00:00.000Z",
                    "repoNames":["yarvis"],"lastActiveAt":"2026-11-26T09:00:00.000Z",
                    "prs":[{"repoName":"yarvis","prNumber":42,"prState":"open","isDraft":true,"mergeable":"MERGEABLE",
                            "checkRollup":"pending","reviewDecision":null}]}]""",
            ),
        )
        val list = client.workspaces(badges = true)

        val row = list.single()
        assertEquals("Fix login", row.name)
        assertEquals(listOf("yarvis"), row.repoNames)
        assertEquals(42, row.prs.single().prNumber)
        assertEquals(true, row.prs.single().isDraft)
        assertNull(row.prs.single().reviewDecision)
        val request = server.next()
        assertEquals("/api/sidecar/api/workspaces", request.url.encodedPath)
        assertEquals("1", request.url.queryParameter("badges"))
        assertEquals("Bearer tok-123", request.headers["Authorization"])
    }

    @Test
    fun `the list without badges sends no query`() = runTest {
        server.enqueue(json(200, "[]"))
        client.workspaces(badges = false)
        assertNull(server.next().url.query)
    }

    @Test
    fun `the detail decodes repos, PRs, tasks and issues`() = runTest {
        server.enqueue(
            json(
                200,
                """{"id":"$workspaceId","name":"Fix login","slug":"fix-login","status":"active","rootPath":"/w/fix-login",
                    "summary":null,"mergedPrUrl":null,"error":null,"archivedAt":null,"createdAt":"2026-11-20T10:00:00.000Z",
                    "repos":[{"id":"wr1","workspaceId":"$workspaceId","repoId":"r1","status":"ready","branch":"yarvis/fix-login",
                              "baseBranch":"main","worktreePath":"/w/fix-login/yarvis","setupLog":"ok\n","setupExitCode":0,"error":null,
                              "repo":{"id":"r1","name":"yarvis","owner":"bennettaur","repo":"yarvis","cloneUrl":"git@github.com:bennettaur/yarvis.git","defaultBranch":"main","provider":"github"},
                              "prs":[{"prNumber":42,"prUrl":"https://github.com/bennettaur/yarvis/pull/42","prState":"open","headBranch":null,
                                      "isDraft":false,"mergeable":"MERGEABLE","checkRollup":"success",
                                      "checks":{"total":3,"success":3,"failure":0,"pending":0},"reviewDecision":"approved","lastError":null}]}],
                    "tasks":[{"id":"t1","title":"Fix the login bug","status":"open","createdAt":"2026-11-20T10:00:00.000Z"}],
                    "issues":[{"id":"i1","provider":"github","sourceKey":"bennettaur/yarvis","externalId":"17","title":"Login fails","url":"https://github.com/bennettaur/yarvis/issues/17"}]}""",
            ),
        )
        val detail = client.workspace(workspaceId, viewing = true)

        val repo = detail.repos.single()
        assertEquals("bennettaur/yarvis", repo.repo.fullName)
        assertEquals(3, repo.prs.single().checks?.success)
        assertEquals("Fix the login bug", detail.tasks.single().title)
        assertEquals("17", detail.issues.single().externalId)
        val request = server.next()
        assertEquals("/api/sidecar/api/workspaces/$workspaceId", request.url.encodedPath)
        assertEquals("1", request.url.queryParameter("viewing"))
    }

    @Test
    fun `create sends only what was chosen and decodes the new workspace`() = runTest {
        server.enqueue(
            json(
                201,
                """{"id":"$workspaceId","name":"Fix login","slug":"fix-login","status":"creating","rootPath":"/w/fix-login",
                    "summary":null,"mergedPrUrl":null,"error":null,"archivedAt":null,"createdAt":"2026-11-20T10:00:00.000Z",
                    "repoNames":["yarvis"]}""",
            ),
        )
        val created = client.createWorkspace(
            NewWorkspace(
                name = "Fix login",
                repoIds = listOf("r1", "r2"),
                existingBranches = mapOf("r1" to "feature/x", "r2" to ""),
                taskId = "",
                startWork = true,
            ),
        )

        assertEquals("creating", created.status)
        assertTrue(created.prs.isEmpty())
        val request = server.next()
        assertEquals("POST", request.method)
        assertEquals("/api/sidecar/api/workspaces", request.url.encodedPath)
        assertEquals(
            Json.parseToJsonElement(
                """{"name":"Fix login","repoIds":["r1","r2"],"existingBranches":{"r1":"feature/x"},"startWork":true}""",
            ),
            bodyOf(request),
        )
        assertEquals(0, prompts)
    }

    @Test
    fun `provision posts and decodes every event type`() = runTest {
        server.enqueue(
            sse(
                """{"type":"repo-start","workspaceRepoId":"wr1","repo":"yarvis"}""",
                """{"type":"log","workspaceRepoId":"wr1","text":"Installing…\n"}""",
                """{"type":"something-new","x":1}""",
                """{"type":"repo-done","workspaceRepoId":"wr1","status":"ready","exitCode":0}""",
                """{"type":"repo-error","workspaceRepoId":"wr2","message":"clone failed"}""",
                """{"type":"error","message":"disk full"}""",
                """{"type":"done","status":"error"}""",
            ),
        )
        val events = client.provision(workspaceId).toList()

        assertEquals(
            listOf(
                ProvisionEvent.RepoStart("wr1", "yarvis"),
                ProvisionEvent.Log("wr1", "Installing…\n"),
                ProvisionEvent.RepoDone("wr1", "ready"),
                ProvisionEvent.RepoError("wr2", "clone failed"),
                ProvisionEvent.Error("disk full"),
                ProvisionEvent.Done("error"),
            ),
            events,
        )
        val request = server.next()
        assertEquals("POST", request.method)
        assertEquals("/api/sidecar/api/workspaces/$workspaceId/provision", request.url.encodedPath)
        assertEquals("text/event-stream", request.headers["Accept"])
    }

    @Test
    fun `a refused provision surfaces the error`() = runTest {
        server.enqueue(json(404, """{"error":"not found"}"""))
        try {
            client.provision(workspaceId).toList()
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(404, e.status)
        }
    }

    @Test
    fun `archive sends the request and accepts 202`() = runTest {
        server.enqueue(json(202, """{"id":"$workspaceId","status":"archiving"}"""))
        client.archiveWorkspace(
            workspaceId,
            ArchiveRequest(summary = "Fixed it", mergedPrUrl = "https://github.com/bennettaur/yarvis/pull/42", force = true, closeIssueIds = listOf("i1")),
        )

        val request = server.next()
        assertEquals("/api/sidecar/api/workspaces/$workspaceId/archive", request.url.encodedPath)
        assertEquals(
            Json.parseToJsonElement(
                """{"summary":"Fixed it","mergedPrUrl":"https://github.com/bennettaur/yarvis/pull/42","force":true,"closeIssueIds":["i1"]}""",
            ),
            bodyOf(request),
        )
    }

    @Test
    fun `ignore-error and agent stop post to their routes`() = runTest {
        server.enqueue(json(200, "{}"))
        server.enqueue(json(200, """{"ok":true}"""))
        client.ignoreWorkspaceError(workspaceId)
        client.stopAgent(workspaceId)

        assertEquals("/api/sidecar/api/workspaces/$workspaceId/ignore-error", server.next().url.encodedPath)
        val stop = server.next()
        assertEquals("POST", stop.method)
        assertEquals("/api/sidecar/api/workspaces/$workspaceId/agent/stop", stop.url.encodedPath)
    }

    @Test
    fun `starting the agent sends the core command's arguments`() = runTest {
        server.enqueue(MockResponse.Builder().code(204).build())
        server.enqueue(MockResponse.Builder().code(204).build())
        val workspace = WorkspaceDetail(id = workspaceId, name = "Fix login", status = "active", rootPath = "/w/fix-login")
        client.startAgent(workspace, harness = "pi")
        client.startAgent(workspace, harness = null)

        val first = server.next()
        assertEquals("POST", first.method)
        assertEquals("/api/core/pty_start_claude", first.url.encodedPath)
        assertEquals(
            Json.parseToJsonElement(
                """{"workspaceId":"$workspaceId","cwd":"/w/fix-login","name":"Fix login","remoteControl":false,"harness":"pi"}""",
            ),
            bodyOf(first),
        )
        assertEquals(
            Json.parseToJsonElement("""{"workspaceId":"$workspaceId","cwd":"/w/fix-login","name":"Fix login","remoteControl":false}"""),
            bodyOf(server.next()),
        )
    }

    @Test
    fun `agent config decodes the harnesses`() = runTest {
        server.enqueue(
            json(
                200,
                """{"name":"Claude","command":"claude","defaultHarness":"claude",
                    "harnesses":[{"id":"claude","name":"Claude","kind":"claude-code","command":"claude"},
                                 {"id":"pi","name":"Pi","kind":"pi","command":"pi"}]}""",
            ),
        )
        val config = client.agentConfig()

        assertEquals("claude", config.defaultHarness)
        assertEquals(listOf("claude", "pi"), config.harnesses.map { it.id })
        assertEquals("claude-code", config.harnesses.first().kind)
        val request = server.next()
        assertEquals("/api/core/get_agent_config", request.url.encodedPath)
        assertEquals(Json.parseToJsonElement("{}"), bodyOf(request))
    }

    @Test
    fun `repos, branches and open tasks read their routes`() = runTest {
        server.enqueue(
            json(
                200,
                """[{"id":"r1","name":"yarvis","owner":"bennettaur","repo":"yarvis","cloneUrl":"git@github.com:bennettaur/yarvis.git",
                     "defaultBranch":"main","provider":"github","createdAt":"2026-11-01T00:00:00.000Z"}]""",
            ),
        )
        server.enqueue(json(200, """["main","feature/x"]"""))
        server.enqueue(json(200, """[{"id":"t1","title":"Fix the login bug","status":"open"}]"""))

        assertEquals("bennettaur/yarvis", client.repos().single().fullName)
        assertEquals(listOf("main", "feature/x"), client.repoBranches("r1"))
        assertEquals("t1", client.openTasks().single().id)

        assertEquals("/api/sidecar/api/repos", server.next().url.encodedPath)
        assertEquals("/api/sidecar/api/repos/r1/branches", server.next().url.encodedPath)
        val tasks = server.next()
        assertEquals("/api/sidecar/api/tasks", tasks.url.encodedPath)
        assertEquals("open", tasks.url.queryParameter("status"))
    }

    @Test
    fun `the pty list decodes the sessions`() = runTest {
        server.enqueue(
            json(
                200,
                """{"sessions":[
                    {"id":"ws-claude:$workspaceId","kind":"agent","workspaceId":"$workspaceId","cwd":"/w/fix-login",
                     "harness":{"id":"claude","name":"Claude"},"startedAt":1763600000000,"running":true,"exitCode":null,"attached":1},
                    {"id":"tab:terminal/t1/p1","kind":"shell","workspaceId":null,"cwd":null,"harness":null,
                     "startedAt":1763600005000,"running":false,"exitCode":0,"attached":0}]}""",
            ),
        )
        val sessions = client.ptySessions()

        assertEquals(listOf("agent", "shell"), sessions.map { it.kind })
        assertEquals("Claude", sessions.first().harness?.name)
        assertEquals(0, sessions.last().exitCode)
        assertFalse(sessions.last().running)
        assertEquals("/api/pty", server.next().url.encodedPath)
    }

    @Test
    fun `pty exists and kill are core commands naming the id`() = runTest {
        server.enqueue(json(200, "true"))
        server.enqueue(MockResponse.Builder().code(204).build())
        val id = "ws:$workspaceId/t1/p1"

        assertTrue(client.ptyExists(id))
        client.ptyKill(id)

        val exists = server.next()
        assertEquals("/api/core/pty_exists", exists.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"id":"$id"}"""), bodyOf(exists))
        val kill = server.next()
        assertEquals("/api/core/pty_kill", kill.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"id":"$id"}"""), bodyOf(kill))
    }
}
