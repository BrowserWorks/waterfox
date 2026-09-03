/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const { ChatConversation, MESSAGE_ROLE, ChatMessage } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
  );

const { SecurityProperties } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/SecurityProperties.sys.mjs"
);

const { MEMORIES_FLAG_SOURCE, SYSTEM_PROMPT_TYPE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

const { UserRoleOpts, AssistantRoleOpts, ToolRoleOpts } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs"
  );

const { MemoryStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/services/MemoryStore.sys.mjs"
);

const { MemoriesManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs"
);

const { EmbeddingsGenerator } = ChromeUtils.importESModule(
  "chrome://global/content/ml/EmbeddingsGenerator.sys.mjs"
);

const { _setLoadPromptForTesting } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

add_task(function test_ChatConversation_constructor_defaults() {
  const conversation = new ChatConversation({});

  Assert.withSoftAssertions(function (soft) {
    soft.equal(conversation.id.length, 36);
    soft.ok(Array.isArray(conversation.messages));
    soft.ok(!isNaN(conversation.createdDate));
    soft.ok(!isNaN(conversation.updatedDate));
    soft.strictEqual(conversation.title, undefined);
    soft.strictEqual(conversation.description, undefined);
    soft.strictEqual(conversation.pageUrl, undefined);
    soft.strictEqual(conversation.pageMeta, undefined);
    soft.strictEqual(conversation.memoriesToggled, null);
  });
});

add_task(function test_ChatConversation_memoriesToggled_property() {
  Assert.withSoftAssertions(soft => {
    // Test default value
    const conversation1 = new ChatConversation({});
    soft.equal(
      conversation1.memoriesToggled,
      null,
      "Default memoriesToggled should be null"
    );

    // Test setting via constructor
    const conversation2 = new ChatConversation({ memoriesToggled: true });
    soft.equal(
      conversation2.memoriesToggled,
      true,
      "Constructor should set memoriesToggled to true"
    );

    const conversation3 = new ChatConversation({ memoriesToggled: false });
    soft.equal(
      conversation3.memoriesToggled,
      false,
      "Constructor should set memoriesToggled to false"
    );

    // Test setting via property
    conversation1.memoriesToggled = true;
    soft.equal(
      conversation1.memoriesToggled,
      true,
      "Should be able to set memoriesToggled to true"
    );

    conversation1.memoriesToggled = false;
    soft.equal(
      conversation1.memoriesToggled,
      false,
      "Should be able to set memoriesToggled to false"
    );

    conversation1.memoriesToggled = null;
    soft.equal(
      conversation1.memoriesToggled,
      null,
      "Should be able to reset memoriesToggled to null"
    );
  });
});

add_task(function test_ChatConversation_addMessage() {
  const conversation = new ChatConversation({});

  const content = {
    type: "text",
    content: "hello world",
    userContext: {},
  };

  conversation.addMessage(
    MESSAGE_ROLE.USER,
    content,
    new URL("https://www.mozilla.com"),
    0
  );

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.strictEqual(message.role, MESSAGE_ROLE.USER);
    soft.strictEqual(message.content, content);
    soft.strictEqual(message.pageUrl.href, "https://www.mozilla.com/");
    soft.strictEqual(message.turnIndex, 0);
  });
});

add_task(function test_invalidRole_ChatConversation_addMessage() {
  const conversation = new ChatConversation({});

  const content = {
    type: "text",
    content: "hello world",
    userContext: {},
  };

  conversation.addMessage(313, content, new URL("https://www.mozilla.com"), 0);

  Assert.equal(conversation.messages.length, 0);
});

add_task(function test_negativeTurnIndex_ChatConversation_addMessage() {
  const conversation = new ChatConversation({});

  const content = {
    type: "text",
    content: "hello world",
    userContext: {},
  };

  conversation.addMessage(
    MESSAGE_ROLE.USER,
    content,
    new URL("https://www.mozilla.com"),
    -1
  );
  const message = conversation.messages[0];

  Assert.equal(message.turnIndex, 0);
});

add_task(function test_parentMessageId_ChatConversation_addMessage() {
  const conversation = new ChatConversation({});

  const content = {
    type: "text",
    content: "hello world",
    userContext: {},
  };

  conversation.addMessage(
    MESSAGE_ROLE.USER,
    content,
    new URL("https://www.mozilla.com"),
    0
  );

  conversation.addMessage(
    MESSAGE_ROLE.ASSISTANT,
    content,
    new URL("https://www.mozilla.com"),
    0
  );

  const userMsg = conversation.messages[0];
  const assistantMsg = conversation.messages[1];

  Assert.equal(assistantMsg.parentMessageId, userMsg.id);
});

add_task(function test_ordinal_ChatConversation_addMessage() {
  const conversation = new ChatConversation({});

  const content = {
    type: "text",
    content: "hello world",
    userContext: {},
  };

  conversation.addMessage(
    MESSAGE_ROLE.USER,
    content,
    new URL("https://www.mozilla.com"),
    0
  );

  conversation.addMessage(
    MESSAGE_ROLE.ASSISTANT,
    content,
    new URL("https://www.mozilla.com"),
    0
  );

  const userMsg = conversation.messages[0];
  const assistantMsg = conversation.messages[1];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(userMsg.ordinal, 1);
    soft.equal(assistantMsg.ordinal, 2);
  });
});

add_task(function test_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(content, new URL("https://www.mozilla.com"));

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.USER);
    soft.equal(message.turnIndex, 1);
    soft.deepEqual(message.pageUrl, new URL("https://www.mozilla.com"));
    soft.deepEqual(message.content, {
      type: "text",
      body: "user to assistant msg",
      userContext: {},
      contextPageUrl: "https://www.mozilla.com/",
    });
  });
});

add_task(function test_revisionRootMessageId_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(content, "https://www.firefox.com");

  const message = conversation.messages[0];

  Assert.equal(message.revisionRootMessageId, message.id);
});

add_task(function test_opts_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(
    content,
    "https://www.firefox.com",
    new UserRoleOpts({ revisionRootMessageId: "321" })
  );

  const message = conversation.messages[0];

  Assert.equal(message.revisionRootMessageId, "321");
});

add_task(async function test_userContext_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  const userContext = { testContextInfo: "123" };
  conversation.addUserMessage(
    content,
    "https://www.firefox.com",
    new UserRoleOpts({ revisionRootMessageId: "321" }),
    userContext
  );

  const message = conversation.messages[0];

  Assert.deepEqual(message.content.userContext, userContext);
});

add_task(function test_contextPageUrl_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  conversation.addUserMessage(
    "user msg",
    new URL("https://www.mozilla.com/page")
  );

  const message = conversation.messages[0];

  Assert.equal(message.content.contextPageUrl, "https://www.mozilla.com/page");
});

add_task(function test_noContextPageUrl_ChatConversation_addUserMessage() {
  const conversation = new ChatConversation({});

  conversation.addUserMessage("user msg", null);

  const message = conversation.messages[0];

  Assert.ok(!("contextPageUrl" in message.content));
});

add_task(function test_ChatConversation_addAssistantMessage() {
  const conversation = new ChatConversation({});

  const content = "response from assistant";
  conversation.addAssistantMessage("text", content);

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.ASSISTANT);
    soft.equal(message.turnIndex, 0);
    soft.deepEqual(message.pageUrl, null);
    soft.deepEqual(message.content, {
      type: "text",
      body: "response from assistant",
    });
    soft.strictEqual(message.modelId, null, "modelId should default to false");
    soft.strictEqual(message.params, null, "params should default to null");
    soft.strictEqual(message.usage, null, "usage should default to null");
    soft.strictEqual(
      message.memoriesEnabled,
      false,
      "memoriesEnabled should default to false"
    );
    soft.strictEqual(
      message.memoriesFlagSource,
      null,
      "memoriesFlagSource should default to null"
    );
    soft.deepEqual(
      message.memoriesApplied,
      [],
      "memoriesApplied should default to empty array"
    );
    soft.deepEqual(
      message.webSearchQueries,
      [],
      "webSearchQueries should default to empty array"
    );
  });
});

add_task(function test_opts_ChatConversation_addAssistantMessage() {
  const conversation = new ChatConversation({});

  const content = "response from assistant";
  const assistantOpts = new AssistantRoleOpts(
    "the-model-id",
    { some: "params for model" },
    { usage: "data" },
    true,
    1,
    ["memory"],
    ["search"]
  );
  conversation.addAssistantMessage("text", content, assistantOpts);

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.ASSISTANT);
    soft.equal(message.turnIndex, 0);
    soft.deepEqual(message.pageUrl, null);
    soft.deepEqual(message.content, {
      type: "text",
      body: "response from assistant",
    });
    soft.strictEqual(
      message.modelId,
      "the-model-id",
      "modelId should be 'the-model-id'"
    );
    soft.deepEqual(
      message.params,
      { some: "params for model" },
      'params should equal { some: "params for model"}'
    );
    soft.deepEqual(
      message.usage,
      { usage: "data" },
      'usage should equal {"usage": "data"}'
    );
    soft.strictEqual(
      message.memoriesEnabled,
      true,
      "memoriesEnabled should equal true"
    );
    soft.strictEqual(
      message.memoriesFlagSource,
      1,
      "memoriesFlagSource equal 1"
    );
    soft.deepEqual(
      message.memoriesApplied,
      ["memory"],
      "memoriesApplied should equal ['memory']"
    );
    soft.deepEqual(
      message.webSearchQueries,
      ["search"],
      "memoriesApplied should equal ['search']"
    );
  });
});

add_task(function test_ChatConversation_addToolCallMessage() {
  const conversation = new ChatConversation({});

  const content = {
    random: "tool call specific keys",
  };
  conversation.addToolCallMessage(content);

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.TOOL);
    soft.equal(message.turnIndex, 0);
    soft.deepEqual(message.pageUrl, null);
    soft.deepEqual(message.content, {
      random: "tool call specific keys",
    });
    soft.equal(message.modelId, null, "modelId should default to null");
  });
});

add_task(function test_opts_ChatConversation_addToolCallMessage() {
  const conversation = new ChatConversation({});

  const content = {
    random: "tool call specific keys",
  };
  conversation.addToolCallMessage(content, new ToolRoleOpts("the-model-id"));

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.TOOL);
    soft.equal(message.turnIndex, 0);
    soft.deepEqual(message.pageUrl, null);
    soft.deepEqual(message.content, {
      random: "tool call specific keys",
    });
    soft.equal(
      message.modelId,
      "the-model-id",
      "modelId should equal the-model-id"
    );
  });
});

add_task(function test_ChatConversation_addSystemMessage() {
  const conversation = new ChatConversation({});

  const content = {
    random: "system call specific keys",
  };
  conversation.addSystemMessage("text", content);

  const message = conversation.messages[0];

  Assert.withSoftAssertions(function (soft) {
    soft.equal(message.role, MESSAGE_ROLE.SYSTEM);
    soft.equal(message.turnIndex, 0);
    soft.deepEqual(message.pageUrl, null);
    soft.deepEqual(message.content, {
      type: "text",
      body: { random: "system call specific keys" },
    });
  });
});

add_task(function test_ChatConversation_getSitesList() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(content, new URL("https://www.mozilla.com"));
  conversation.addUserMessage(content, new URL("https://www.mozilla.com"));
  conversation.addUserMessage(content, new URL("https://www.firefox.com"));
  conversation.addUserMessage(content, new URL("https://www.cnn.com"));
  conversation.addUserMessage(content, new URL("https://www.espn.com"));
  conversation.addUserMessage(content, new URL("https://www.espn.com"));

  const sites = conversation.getSitesList();

  Assert.deepEqual(sites, [
    URL.parse("https://www.mozilla.com/"),
    URL.parse("https://www.firefox.com/"),
    URL.parse("https://www.cnn.com/"),
    URL.parse("https://www.espn.com/"),
  ]);
});

add_task(function test_ChatConversation_getMostRecentPageVisited() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(content, new URL("https://www.mozilla.com"));
  conversation.addUserMessage(content, new URL("https://www.mozilla.com"));
  conversation.addUserMessage(content, new URL("https://www.firefox.com"));
  conversation.addUserMessage(content, new URL("https://www.cnn.com"));
  conversation.addUserMessage(content, new URL("https://www.espn.com"));
  conversation.addUserMessage(content, new URL("https://www.espn.com"));

  const mostRecentPageVisited = conversation.getMostRecentPageVisited();

  Assert.equal(mostRecentPageVisited, "https://www.espn.com/");
});

add_task(function test_noBrowsing_ChatConversation_getMostRecentPageVisited() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";
  conversation.addUserMessage(content, new URL("about:aiwindow"));
  conversation.addUserMessage(content, null);
  conversation.addUserMessage(content, null);

  const mostRecentPageVisited = conversation.getMostRecentPageVisited();

  Assert.equal(mostRecentPageVisited, null);
});

add_task(function test_renderState_includes_tool_messages() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("get open tab", "about:aiwindow");
  conversation.addAssistantMessage("text", "Checking");
  conversation.addToolCallMessage({
    tool_call_id: "tc_1",
    body: [{ url: "https://example.com/", title: "Example" }],
    name: "get_open_tabs",
  });
  conversation.addSystemMessage("text", "some system message");
  conversation.addAssistantMessage("text", "You have one tab open.");

  const renderState = conversation.renderState();

  Assert.equal(renderState[0].role, MESSAGE_ROLE.USER);
  Assert.equal(renderState[1].role, MESSAGE_ROLE.ASSISTANT);
  Assert.equal(renderState[2].role, MESSAGE_ROLE.TOOL);
  Assert.equal(renderState[2].content.name, "get_open_tabs");
  Assert.equal(renderState[3].role, MESSAGE_ROLE.ASSISTANT);
});

add_task(function test_ChatConversation_currentTurnIndex() {
  const conversation = new ChatConversation({});

  const content = "user to assistant msg";

  conversation.addSystemMessage("text", "the system prompt");
  conversation.addUserMessage(content, "about:aiwindow");
  conversation.addAssistantMessage("text", "a response");
  conversation.addUserMessage(content, "about:aiwindow");
  conversation.addAssistantMessage("text", "a response");
  conversation.addUserMessage(content, "about:aiwindow");
  conversation.addAssistantMessage("text", "a response");
  conversation.addUserMessage(content, "about:aiwindow");
  conversation.addAssistantMessage("text", "a response");
  conversation.addUserMessage(content, "about:aiwindow");
  conversation.addAssistantMessage("text", "a response");

  Assert.deepEqual(conversation.currentTurnIndex(), 4);
});

add_task(function test_ChatConversation_helpersTurnIndexing() {
  const conversation = new ChatConversation({});

  conversation.addSystemMessage("text", "the system prompt");
  conversation.addUserMessage("a user's prompt", "https://www.somesite.com");
  conversation.addToolCallMessage({ some: "tool call details" });
  conversation.addAssistantMessage("text", "the llm response");
  conversation.addUserMessage(
    "a user's second prompt",
    "https://www.somesite.com"
  );
  conversation.addToolCallMessage({ some: "more tool call details" });
  conversation.addAssistantMessage("text", "the second llm response");

  Assert.withSoftAssertions(function (soft) {
    soft.equal(conversation.messages.length, 7);

    soft.equal(conversation.messages[0].turnIndex, 0);
    soft.equal(conversation.messages[1].turnIndex, 0);
    soft.equal(conversation.messages[2].turnIndex, 0);
    soft.equal(conversation.messages[3].turnIndex, 0);
    soft.equal(conversation.messages[4].turnIndex, 1);
    soft.equal(conversation.messages[5].turnIndex, 1);
    soft.equal(conversation.messages[6].turnIndex, 1);
  });
});

add_task(function test_ChatConversation_getMessagesInOpenAiFormat() {
  const conversation = new ChatConversation({});
  conversation.addSystemMessage("text", "the system prompt");
  conversation.addUserMessage(
    "a user's prompt",
    "https://www.somesite.com",
    new UserRoleOpts(),
    { testContext: "321" }
  );
  conversation.addToolCallMessage({
    tool_call_id: "123",
    name: "tool_1",
    body: [1, 2, 3],
  });
  conversation.addAssistantMessage("text", "the llm response");
  conversation.addUserMessage(
    "a user's second prompt",
    "some question",
    new UserRoleOpts(),
    { testContext: "654" }
  );
  conversation.addToolCallMessage({
    tool_call_id: "456",
    name: "tool_1",
    body: [4, 5, 6],
  });
  conversation.addAssistantMessage("text", "the second llm response");

  const openAiFormat = conversation.getMessagesInOpenAiFormat();

  Assert.deepEqual(openAiFormat, [
    { role: "system", content: "the system prompt" },
    { role: "user", content: "a user's prompt" },
    { role: "tool", content: "[1,2,3]", name: "tool_1", tool_call_id: "123" },
    { role: "assistant", content: "the llm response" },
    { role: "user", content: "654" },
    { role: "user", content: "a user's second prompt" },
    { role: "tool", content: "[4,5,6]", name: "tool_1", tool_call_id: "456" },
    { role: "assistant", content: "the second llm response" },
  ]);
});

add_task(async function test_unrelatedMessage_ChatConversation_retryMessage() {
  const conversation = new ChatConversation({});
  conversation.addSystemMessage("text", "the system prompt");
  conversation.addUserMessage("a user's prompt", "https://www.somesite.com");

  const unrelatedMessage = new ChatMessage({
    ordinal: 0,
    role: MESSAGE_ROLE.USER,
    content: "some content",
    turnIndex: 0,
  });

  await Assert.rejects(
    conversation.retryMessage(unrelatedMessage),
    err =>
      /Unrelated message/.test(err.message) &&
      err.clientReason === "retryInvalidMessage",
    "retryMessage should reject with clientReason retryInvalidMessage"
  );
});

add_task(async function test_nonUserMessage_ChatConversation_retryMessage() {
  const conversation = new ChatConversation({});
  conversation.addSystemMessage("text", "the system prompt");
  conversation.addUserMessage("a user's prompt", "https://www.somesite.com");

  await Assert.rejects(
    conversation.retryMessage(conversation.messages[0]),
    err =>
      /Not a user message/.test(err.message) &&
      err.clientReason === "retryInvalidMessage",
    "retryMessage should reject with clientReason retryInvalidMessage"
  );
});

add_task(
  async function test_ChatConversation_retryMessage_returnsRemovedMessages() {
    let sandbox = lazy.sinon.createSandbox();

    const conversation = new ChatConversation({});

    sandbox.stub(ChatConversation, "getRealTimeInfo").callsFake(() => {
      conversation.addSystemMessage(
        SYSTEM_PROMPT_TYPE.REAL_TIME,
        "real time data"
      );
    });

    sandbox.stub(conversation, "getMemoriesContext").callsFake(() => {
      conversation.addSystemMessage(
        SYSTEM_PROMPT_TYPE.MEMORIES,
        "memories data"
      );
    });

    conversation.addSystemMessage("text", "the system prompt");
    conversation.addUserMessage("a user's prompt", "https://www.somesite.com");
    conversation.addToolCallMessage({ some: "tool call details" });
    conversation.addAssistantMessage("text", "the llm response");
    conversation.addUserMessage("a user's second prompt", "some question");
    conversation.addToolCallMessage({ some: "more tool call details" });
    conversation.addAssistantMessage("text", "the second llm response");

    const toDeleteMessages = await conversation.retryMessage(
      conversation.messages[1]
    );

    Assert.withSoftAssertions(function (soft) {
      soft.equal(toDeleteMessages.length, 6, "Incorrect number of messages");
      soft.equal(toDeleteMessages[0].content.body, "a user's prompt");
      soft.equal(toDeleteMessages[1].content.some, "tool call details");
      soft.equal(toDeleteMessages[2].content.body, "the llm response");
      soft.equal(toDeleteMessages[3].content.body, "a user's second prompt");
      soft.equal(toDeleteMessages[4].content.some, "more tool call details");
      soft.equal(toDeleteMessages[5].content.body, "the second llm response");
    });

    sandbox.restore();
  }
);

add_task(async function test_filtersEphemeral_ChatConversation_retryMessage() {
  const conversation = new ChatConversation({});

  conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.TEXT, "the system prompt");
  conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.REAL_TIME, "real time data");
  conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.MEMORIES, "memories data");
  conversation.addUserMessage("a user's prompt", "https://www.somesite.com");
  conversation.addAssistantMessage("text", "the llm response");

  const retryTarget = conversation.messages.find(
    m => m.role === MESSAGE_ROLE.USER
  );
  const deleted = await conversation.retryMessage(retryTarget);

  Assert.withSoftAssertions(function (soft) {
    soft.equal(
      conversation.messages.length,
      1,
      "Only the base system prompt should remain"
    );
    soft.equal(
      conversation.messages[0].content.type,
      SYSTEM_PROMPT_TYPE.TEXT,
      "Remaining message should be the base system prompt"
    );
    soft.equal(
      deleted.length,
      4,
      "Should return ephemeral messages and spliced messages"
    );
    soft.equal(
      deleted[0].content.type,
      SYSTEM_PROMPT_TYPE.REAL_TIME,
      "First deleted should be the real time message"
    );
    soft.equal(
      deleted[1].content.type,
      SYSTEM_PROMPT_TYPE.MEMORIES,
      "Second deleted should be the memories message"
    );
    soft.equal(
      deleted[2].content.body,
      "a user's prompt",
      "Third deleted should be the retried user message"
    );
    soft.equal(
      deleted[3].content.body,
      "the llm response",
      "Fourth deleted should be the assistant message"
    );
  });
});

add_task(
  async function test_uniqueOrdinalsWithoutMemories_ChatConversation_retryMessage() {
    const conversation = new ChatConversation({});

    conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.TEXT, "the system prompt");
    conversation.addSystemMessage(
      SYSTEM_PROMPT_TYPE.REAL_TIME,
      "real time data"
    );
    conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.MEMORIES, "memories data");
    conversation.addUserMessage("a user's prompt", "https://www.somesite.com");
    conversation.addAssistantMessage("text", "the llm response");

    const retryTarget = conversation.messages.find(
      m => m.role === MESSAGE_ROLE.USER
    );
    const originalUserOrdinal = retryTarget.ordinal;
    await conversation.retryMessage(retryTarget);

    conversation.addSystemMessage(
      SYSTEM_PROMPT_TYPE.REAL_TIME,
      "new real time data"
    );
    conversation.addUserMessage("a user's prompt", "https://www.somesite.com");
    conversation.addAssistantMessage("text", "the new llm response");

    const ordinals = conversation.messages.map(m => m.ordinal);
    const uniqueOrdinals = new Set(ordinals);

    Assert.withSoftAssertions(function (soft) {
      soft.equal(
        ordinals.length,
        uniqueOrdinals.size,
        "All ordinals should be unique after retry without memories"
      );
      soft.ok(
        conversation.messages
          .filter(m => m.role === MESSAGE_ROLE.ASSISTANT)
          .at(-1).ordinal > originalUserOrdinal,
        "New assistant ordinal must be greater than original user ordinal"
      );
    });
  }
);

add_task(async function test_returnsContent_ChatConversation_getRealTimeInfo() {
  console.log(Object.keys(lazy.sinon));
  const mockGetRealTimeMapping = lazy.sinon.stub().resolves({
    todayDate: "2024-01-15",
    url: "https://example.com",
    title: "Example",
    hasTabInfo: false,
    locale: "en-US",
    timezone: "America/Los_Angeles",
    isoTimestamp: "2024-01-15T10:30:00",
  });
  const loadPromptStub = lazy.sinon
    .stub()
    .resolves("Current date: {todayDate}\nLocale: {locale}");
  _setLoadPromptForTesting(loadPromptStub);

  const realTimeInfo = await ChatConversation.getRealTimeInfo({
    getRealTimeMapping: mockGetRealTimeMapping,
  });

  Assert.withSoftAssertions(function (soft) {
    soft.ok(loadPromptStub.called, "loadPrompt should be called");
  });
  Assert.equal(
    realTimeInfo,
    "Current date: 2024-01-15\nLocale: en-US",
    "getRealTimeInfo returns the expected contexutal information"
  );
  _setLoadPromptForTesting(null);
});

add_task(
  async function test_returnsNoContent_ChatConversation_getRealTimeInfo() {
    const mockGetRealTimeMapping = lazy.sinon.stub().resolves(null);

    const realTimeInfo = await ChatConversation.getRealTimeInfo({
      getRealTimeMapping: mockGetRealTimeMapping,
    });

    Assert.equal(
      realTimeInfo,
      null,
      "getRealTimeInfo returns null if constructRealTime returns an empty object"
    );
  }
);

add_task(
  async function test_returnsContent_ChatConversation_getMemoriesContext() {
    console.log(Object.keys(lazy.sinon));
    const constructMemories = lazy.sinon
      .stub()
      .resolves({ content: "memories data" });

    const conversation = new ChatConversation({});
    const memoriesContext = await conversation.getMemoriesContext(
      "hello",
      constructMemories,
      new SecurityProperties()
    );

    Assert.withSoftAssertions(function (soft) {
      soft.ok(
        constructMemories.calledWith("hello"),
        "constructMemories should be called with the message"
      );
    });
    Assert.equal(
      memoriesContext,
      "memories data",
      "getMemoriesContext returns the expected memories information"
    );
  }
);

add_task(
  async function test_returnsNoContent_ChatConversation_getMemoriesContext() {
    console.log(Object.keys(lazy.sinon));
    const constructMemories = lazy.sinon.stub().resolves({});

    const conversation = new ChatConversation({});
    const memoriesContext = await conversation.getMemoriesContext(
      "hello",
      constructMemories,
      new SecurityProperties()
    );

    Assert.equal(
      memoriesContext,
      null,
      "getMemoriesContext returns null if constructMemories returns an empty object"
    );
  }
);

add_task(function test_ChatConversation_renderState_filters_phantom_messages() {
  const conversation = new ChatConversation({});

  conversation.addUserMessage("What's the weather?", "about:aiwindow");
  conversation.addAssistantMessage("text", "");
  conversation.addAssistantMessage("function", {
    tool_calls: [
      {
        id: "call_1",
        function: {
          name: "run_search",
          arguments: '{"query":"weather"}',
        },
      },
    ],
  });
  conversation.addAssistantMessage("text", "Here is the weather forecast.");

  const renderState = conversation.renderState();

  Assert.equal(
    renderState.length,
    2,
    "Should only contain user message and real assistant message"
  );
  Assert.equal(renderState[0].role, MESSAGE_ROLE.USER);
  Assert.equal(renderState[1].role, MESSAGE_ROLE.ASSISTANT);
  Assert.equal(renderState[1].content.body, "Here is the weather forecast.");
});

add_task(
  async function test_deduplicatesMemoryIds_ChatConversation_receiveResponse() {
    let sandbox = lazy.sinon.createSandbox();

    const mockMemories = [{ id: "mem-1" }, { id: "mem-2" }];
    sandbox.stub(MemoryStore, "getMemories").resolves(mockMemories);

    const conversation = new ChatConversation({});
    conversation.addAssistantMessage("text", "some response");
    const assistantMsg = conversation.messages.at(-1);
    assistantMsg.memoriesApplied = ["mem-1", "mem-1", "mem-2", "mem-2"];

    async function* emptyStream() {}
    await conversation.receiveResponse(emptyStream());

    Assert.ok(
      MemoryStore.getMemories.calledOnce,
      "MemoryStore.getMemories should be called exactly once"
    );
    const { memoryIds } = MemoryStore.getMemories.firstCall.args[0];
    Assert.equal(
      memoryIds.size,
      2,
      "memoryIds should be a deduplicated Set of size 2"
    );
    Assert.ok(memoryIds.has("mem-1"), "memoryIds should contain mem-1");
    Assert.ok(memoryIds.has("mem-2"), "memoryIds should contain mem-2");
    Assert.deepEqual(
      assistantMsg.memoriesApplied,
      mockMemories,
      "memoriesApplied should be set to the resolved memories"
    );

    sandbox.restore();
  }
);

add_task(async function test_addUserMessage_sets_memories_fields() {
  const conversation = new ChatConversation({});

  const userOpts = new UserRoleOpts({
    memoriesEnabled: false,
    memoriesFlagSource: MEMORIES_FLAG_SOURCE.CONVERSATION,
  });

  await conversation.addUserMessage("hello", null, userOpts);

  const lastUserMessage = conversation.messages
    .filter(m => m.role === MESSAGE_ROLE.USER)
    .at(-1);

  Assert.ok(lastUserMessage, "Last user message exists");
  Assert.equal(
    lastUserMessage.memoriesEnabled,
    false,
    "memoriesEnabled is persisted on the user message"
  );
  Assert.equal(
    lastUserMessage.memoriesFlagSource,
    MEMORIES_FLAG_SOURCE.CONVERSATION,
    "memoriesFlagSource is persisted on the user message"
  );
});

add_task(async function test_generatePrompt_emitsUserMessage() {
  const sandbox = lazy.sinon.createSandbox();
  const conversation = new ChatConversation({});
  _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));
  sandbox.stub(ChatConversation, "getRealTimeInfo").resolves(null);
  sandbox.stub(conversation, "getMemoriesContext").resolves(null);

  let emittedMessage = null;
  conversation.on("chat-conversation:message-update", (_, msg) => {
    emittedMessage = msg;
  });

  await conversation.generatePrompt("hello", null);

  Assert.ok(emittedMessage, "event should have been emitted");
  Assert.equal(emittedMessage.content.body, "hello");
  Assert.equal(emittedMessage.role, MESSAGE_ROLE.USER);
  _setLoadPromptForTesting(null);
  sandbox.restore();
});

add_task(async function test_generatePrompt_skipUserDispatch() {
  const sandbox = lazy.sinon.createSandbox();
  const conversation = new ChatConversation({});
  _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));
  sandbox.stub(ChatConversation, "getRealTimeInfo").resolves(null);
  sandbox.stub(conversation, "getMemoriesContext").resolves(null);

  let emitted = false;
  conversation.on("chat-conversation:message-update", () => {
    emitted = true;
  });

  await conversation.generatePrompt("hello", null, undefined, true);

  Assert.ok(
    !emitted,
    "event should not be emitted when skipUserDispatch is true"
  );
  _setLoadPromptForTesting(null);
  sandbox.restore();
});

add_task(async function test_generatePrompt_memoriesContextErrorDoesNotThrow() {
  let sandbox = lazy.sinon.createSandbox();

  // Seed a memory so getRelevantMemories reaches the embeddings path
  await MemoryStore.addMemory({
    id: "memory-embed-fail",
    memory_summary: "User likes hiking",
    category: "preference",
    intent: "profile",
    reasoning: "Test memory",
    score: 0.5,
    updated_at: Date.now(),
    is_deleted: false,
  });
  MemoriesManager._clearEmbeddingsCache();

  sandbox
    .stub(EmbeddingsGenerator.prototype, "embedMany")
    .rejects(new Error("Failed to download embedding model"));

  const conversation = new ChatConversation({});
  _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));
  sandbox
    .stub(ChatConversation, "getRealTimeInfo")
    .resolves("real time context");

  const result = await conversation.generatePrompt("hello", null, {
    memoriesEnabled: true,
  });

  Assert.ok(result, "generatePrompt should resolve successfully");

  const userMessage = conversation.messages.find(
    m => m.role === MESSAGE_ROLE.USER
  );

  Assert.ok(
    EmbeddingsGenerator.prototype.embedMany.calledOnce,
    "embedMany should have been called exactly once"
  );
  Assert.equal(
    userMessage.content.userContext.realTimeContext,
    "real time context",
    "realTimeContext should still be set despite embeddings failure"
  );
  Assert.ok(
    !("memoriesContext" in userMessage.content.userContext),
    "memoriesContext should not be set when embedMany rejects"
  );

  await MemoryStore.hardDeleteMemory("memory-embed-fail", "other");
  MemoriesManager._clearEmbeddingsCache();
  _setLoadPromptForTesting(null);
  sandbox.restore();
});

add_task(
  async function test_generatePrompt_userContextPopulatedBeforeResolving() {
    const sandbox = lazy.sinon.createSandbox();
    const conversation = new ChatConversation({});
    _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));
    sandbox
      .stub(ChatConversation, "getRealTimeInfo")
      .resolves("real time context");
    sandbox
      .stub(conversation, "getMemoriesContext")
      .resolves("memories context");

    await conversation.generatePrompt("hello", null, {
      memoriesEnabled: true,
    });

    const userMessage = conversation.messages.find(
      m => m.role === MESSAGE_ROLE.USER
    );

    Assert.withSoftAssertions(function (soft) {
      soft.equal(
        userMessage.content.userContext.realTimeContext,
        "real time context",
        "realTimeContext should be set on userContext before generatePrompt resolves"
      );
      soft.equal(
        userMessage.content.userContext.memoriesContext,
        "memories context",
        "memoriesContext should be set on userContext before generatePrompt resolves"
      );
    });
    _setLoadPromptForTesting(null);
    sandbox.restore();
  }
);

add_task(async function test_getRealTimeInfo_setsPrivateData_when_hasTabInfo() {
  const securityProperties = new SecurityProperties();
  const mockGetRealTimeMapping = lazy.sinon.stub().resolves({
    todayDate: "2024-01-15",
    url: "https://example.com",
    title: "Example Page",
    hasTabInfo: true,
    locale: "en-US",
    timezone: "America/Los_Angeles",
    isoTimestamp: "2024-01-15T10:30:00",
  });
  _setLoadPromptForTesting(lazy.sinon.stub().resolves("{todayDate}"));

  await ChatConversation.getRealTimeInfo({
    getRealTimeMapping: mockGetRealTimeMapping,
    securityProperties,
  });

  securityProperties.commit();
  Assert.ok(
    securityProperties.privateData,
    "privateData should be true after commit when hasTabInfo is true"
  );
  _setLoadPromptForTesting(null);
});

add_task(
  async function test_getRealTimeInfo_doesNotSetPrivateData_when_noTabInfo() {
    const securityProperties = new SecurityProperties();
    const mockGetRealTimeMapping = lazy.sinon.stub().resolves({
      todayDate: "2024-01-15",
      hasTabInfo: false,
      locale: "en-US",
      timezone: "America/Los_Angeles",
      isoTimestamp: "2024-01-15T10:30:00",
    });
    _setLoadPromptForTesting(lazy.sinon.stub().resolves("{todayDate}"));

    await ChatConversation.getRealTimeInfo({
      getRealTimeMapping: mockGetRealTimeMapping,
      securityProperties,
    });

    securityProperties.commit();
    Assert.ok(
      !securityProperties.privateData,
      "privateData should remain false when hasTabInfo is false"
    );
    _setLoadPromptForTesting(null);
  }
);

add_task(
  async function test_getMemoriesContext_setsPrivateData_when_memoriesFound() {
    const securityProperties = new SecurityProperties();
    const constructMemories = lazy.sinon
      .stub()
      .resolves({ content: "some memory" });

    const conversation = new ChatConversation({});
    await conversation.getMemoriesContext(
      "hello",
      constructMemories,
      securityProperties
    );

    securityProperties.commit();
    Assert.ok(
      securityProperties.privateData,
      "privateData should be true after commit when memories were found"
    );
  }
);

add_task(
  async function test_getMemoriesContext_doesNotSetPrivateData_when_noMemories() {
    const securityProperties = new SecurityProperties();
    const constructMemories = lazy.sinon.stub().resolves(null);

    const conversation = new ChatConversation({});
    await conversation.getMemoriesContext(
      "hello",
      constructMemories,
      securityProperties
    );

    securityProperties.commit();
    Assert.ok(
      !securityProperties.privateData,
      "privateData should remain false when no memories were found"
    );
  }
);

add_task(
  async function test_generatePrompt_commitsPrivateData_when_hasTabInfo() {
    const conversation = new ChatConversation({});
    const sandbox = lazy.sinon.createSandbox();
    _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));

    sandbox.stub(ChatConversation, "getRealTimeInfo").callsFake(async opts => {
      opts.securityProperties?.setPrivateData();
      return "real time info";
    });
    sandbox.stub(conversation, "getMemoriesContext").resolves(null);

    await conversation.generatePrompt("hello", null);

    Assert.ok(
      conversation.securityProperties.privateData,
      "privateData should be committed true when getRealTimeInfo stages it"
    );
    _setLoadPromptForTesting(null);
    sandbox.restore();
  }
);

add_task(
  async function test_generatePrompt_commitsPrivateData_when_memoriesEnabled() {
    const conversation = new ChatConversation({});
    const sandbox = lazy.sinon.createSandbox();
    _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));

    sandbox.stub(ChatConversation, "getRealTimeInfo").resolves(null);
    sandbox
      .stub(conversation, "getMemoriesContext")
      .callsFake(async (_message, _construct, sp) => {
        sp?.setPrivateData();
        return "some memories";
      });

    await conversation.generatePrompt("hello", null, {
      memoriesEnabled: true,
    });

    Assert.ok(
      conversation.securityProperties.privateData,
      "privateData should be committed true when getMemoriesContext stages it"
    );
    _setLoadPromptForTesting(null);
    sandbox.restore();
  }
);

add_task(
  async function test_generatePrompt_doesNotSetPrivateData_when_noTabOrMemories() {
    const conversation = new ChatConversation({});
    const sandbox = lazy.sinon.createSandbox();
    _setLoadPromptForTesting(lazy.sinon.stub().resolves("system prompt"));

    sandbox.stub(ChatConversation, "getRealTimeInfo").resolves(null);
    sandbox.stub(conversation, "getMemoriesContext").resolves(null);

    await conversation.generatePrompt("hello", null);

    Assert.ok(
      !conversation.securityProperties.privateData,
      "privateData should remain false when no private data was staged"
    );
    _setLoadPromptForTesting(null);
    sandbox.restore();
  }
);

add_task(function test_securityProperties_plainObject_normalization() {
  const conversation = new ChatConversation({
    securityProperties: { untrustedInput: true },
  });

  Assert.withSoftAssertions(function (soft) {
    soft.ok(
      conversation.securityProperties instanceof SecurityProperties,
      "securityProperties should be a SecurityProperties instance"
    );
    soft.equal(
      conversation.securityProperties.untrustedInput,
      true,
      "untrustedInput should be true when explicitly set"
    );
    soft.equal(
      conversation.securityProperties.privateData,
      false,
      "privateData should default to false when missing from input"
    );
  });
});

add_task(async function test_convertUrlToToken_tokenGeneration() {
  const cases = [
    {
      message: "Works for a URL with a path.",
      url: "http://www.github.com/foo/bar/baz",
      expected: "GITHUB_COM_FOO_BAR_BAZ_1",
    },
    {
      message:
        "Returns a new number for a URL that is different but creates the same token.",
      url: "http://www.github.com/foo/bar/baz?ignored",
      expected: "GITHUB_COM_FOO_BAR_BAZ_2",
    },
    {
      message: "Returns the exact same token given another URL",
      url: "http://www.github.com/foo/bar/baz",
      expected: "GITHUB_COM_FOO_BAR_BAZ_1",
    },
    {
      message:
        "Returns a different token given the same URL with a different protocol",
      url: "https://www.github.com/foo/bar/baz",
      expected: "GITHUB_COM_FOO_BAR_BAZ_3",
    },
    {
      message: "Can handle about URLs.",
      url: "about:config",
      expected: "ABOUT_CONFIG_1",
    },
    {
      message: "Uses non-http protocols",
      url: "ftp://github.com/foo/bar/baz",
      expected: "FTP_GITHUB_COM_FOO_BAR_BAZ_1",
    },
    {
      message: "Uses invalid protocols",
      url: "asdf://github.com/foo/bar/baz",
      expected: "ASDF_GITHUB_COM_FOO_BAR_BAZ_1",
    },
    {
      message: "Ignores the port.",
      url: "http://github.com:1234/ignore/port",
      expected: "GITHUB_COM_IGNORE_PORT_1",
    },
    {
      message: "Ignores the params.",
      url: "http://www.github.com/ignore/params?token=xxx",
      expected: "GITHUB_COM_IGNORE_PARAMS_1",
    },
    {
      message: "Ignores the hash.",
      url: "http://www.github.com/ignore/hash/part?token=xxx#hash",
      expected: "GITHUB_COM_IGNORE_HASH_PART_1",
    },
    {
      message: "Truncates text in the host from 110 to 100.",
      url: `http://www.${"a".repeat(110)}.com/foo`,
      expected: "A".repeat(100) + "_1",
    },
    {
      message: "Skips text in the path that is too long",
      url: `http://github.com/skip/long/path/` + "A".repeat(100),
      expected: "GITHUB_COM_SKIP_LONG_PATH_1",
    },
  ];
  // Re-use the chat conversation.
  const conversation = new ChatConversation({});

  for (const { message, url, expected } of cases) {
    const token = conversation.convertUrlToToken(url);
    Assert.equal(token, expected, message);
  }
});

add_task(async function test_generatePrompt_persistsPromptVersion() {
  const sandbox = lazy.sinon.createSandbox();
  const loadPromptStub = lazy.sinon.stub().resolves({
    prompt: "system prompt",
    version: "chat-v1",
  });
  _setLoadPromptForTesting(loadPromptStub);

  const conversation = new ChatConversation({});
  sandbox.stub(ChatConversation, "getRealTimeInfo").resolves(null);
  sandbox.stub(conversation, "getMemoriesContext").resolves(null);

  await conversation.generatePrompt("hello", null);

  Assert.equal(
    loadPromptStub.callCount,
    1,
    "system prompt is loaded with a single loadPrompt call"
  );
  const systemMessage = conversation.messages.find(
    m => m.role === MESSAGE_ROLE.SYSTEM
  );
  Assert.equal(
    systemMessage.content.version,
    "chat-v1",
    "version is stored on the system message content"
  );
  Assert.equal(
    conversation.chatPromptVersion,
    "chat-v1",
    "getter reads the version from the system message"
  );

  _setLoadPromptForTesting(null);
  sandbox.restore();
});

add_task(function test_chatPromptVersion_readsFromExistingSystemMessage() {
  const conversation = new ChatConversation({});
  conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.TEXT, "body", "chat-v2");

  Assert.equal(
    conversation.chatPromptVersion,
    "chat-v2",
    "getter returns the version from a pre-existing system message"
  );
});

add_task(function test_chatPromptVersion_emptyForLegacyMessage() {
  const conversation = new ChatConversation({});
  // Simulate a system message persisted before this change shipped.
  conversation.addSystemMessage(SYSTEM_PROMPT_TYPE.TEXT, "body");
  Assert.equal(
    conversation.chatPromptVersion,
    "",
    "getter returns empty string for legacy system messages with no version"
  );
});

add_task(
  function test_addUIToolToCurrentMessage_attaches_to_existing_message() {
    const conversation = new ChatConversation({});

    // Add a user message and assistant message
    conversation.addUserMessage("Test prompt", null);
    conversation.addAssistantMessage("text", "Here's a response");

    const uiData = {
      uiType: "website-confirmation",
      title: "Test Title",
      description: "Test Description",
      properties: { tabs: [] },
    };

    const result = conversation.addUIToolToCurrentMessage(
      "tool-call-123",
      uiData
    );

    Assert.ok(result.success, "Should return success");
    Assert.equal(
      result.message,
      "Tool UI data added to existing assistant message",
      "Should indicate data was added"
    );

    const lastMessage = conversation.messages.at(-1);
    Assert.ok(lastMessage.toolUIData, "Message should have toolUIData");
    Assert.equal(
      lastMessage.toolUIData.toolCallId,
      "tool-call-123",
      "Tool call ID should match"
    );
    Assert.equal(
      lastMessage.toolUIData.uiType,
      "website-confirmation",
      "UI type should match"
    );
    Assert.equal(
      lastMessage.toolUIData.title,
      "Test Title",
      "Title should match"
    );
  }
);

add_task(function test_addUIToolToCurrentMessage_creates_synthetic_message() {
  const conversation = new ChatConversation({});

  // Only add a user message, no assistant message
  conversation.addUserMessage("Test prompt", null);

  const uiData = {
    uiType: "test-ui",
    title: "Test",
  };

  const result = conversation.addUIToolToCurrentMessage(
    "tool-call-456",
    uiData
  );

  Assert.ok(result.success, "Should return success");

  // Verify synthetic message was created
  const assistantMessages = conversation.messages.filter(
    m => m.role === MESSAGE_ROLE.ASSISTANT && m.content?.type === "text"
  );
  Assert.equal(
    assistantMessages.length,
    1,
    "Should have created one assistant message"
  );
  Assert.equal(
    assistantMessages[0].content.body,
    "",
    "Synthetic message should have empty body"
  );
  Assert.ok(
    assistantMessages[0].toolUIData,
    "Synthetic message should have toolUIData"
  );
});

add_task(function test_addUIToolToCurrentMessage_progressive_updates() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Test prompt", null);
  conversation.addAssistantMessage("text", "Response");

  // First call
  const result1 = conversation.addUIToolToCurrentMessage("tool-call-789", {
    uiType: "test-ui",
    title: "Initial",
    properties: { value: 1 },
  });

  Assert.ok(result1.success, "First call should succeed");
  Assert.ok(!result1.isUpdate, "First call should not be an update");

  const message = conversation.messages.at(-1);
  Assert.equal(
    message.toolUIData.title,
    "Initial",
    "Initial title should be set"
  );
  Assert.equal(message.toolUIData.updateCount, 0, "Update count should be 0");

  // Update call with same toolCallId
  const result2 = conversation.addUIToolToCurrentMessage("tool-call-789", {
    title: "Updated",
    properties: { value: 2, extra: true },
  });

  Assert.ok(result2.success, "Update call should succeed");
  Assert.ok(result2.isUpdate, "Second call should be an update");
  Assert.equal(message.toolUIData.title, "Updated", "Title should be updated");
  Assert.equal(
    message.toolUIData.updateCount,
    1,
    "Update count should increment"
  );
  Assert.equal(
    message.toolUIData.properties.value,
    2,
    "Properties should be merged"
  );
  Assert.ok(
    message.toolUIData.properties.extra,
    "New properties should be added"
  );
});

add_task(
  function test_addUIToolToCurrentMessage_different_toolcallid_replaces() {
    const conversation = new ChatConversation({});
    conversation.addUserMessage("Test prompt", null);
    conversation.addAssistantMessage("text", "Response");

    // Add first UI tool
    conversation.addUIToolToCurrentMessage("tool-call-1", {
      uiType: "test-ui",
      title: "First",
    });

    let lastMessage = conversation.messages.at(-1);
    Assert.equal(
      lastMessage.toolUIData.title,
      "First",
      "First UI data should be present"
    );
    Assert.equal(
      lastMessage.toolUIData.toolCallId,
      "tool-call-1",
      "First tool call ID should be present"
    );

    // Add second UI tool with different ID - should replace
    conversation.addUIToolToCurrentMessage("tool-call-2", {
      uiType: "test-ui",
      title: "Second",
    });

    lastMessage = conversation.messages.at(-1);
    Assert.equal(
      lastMessage.toolUIData.title,
      "Second",
      "Second UI data should replace the first"
    );
    Assert.equal(
      lastMessage.toolUIData.toolCallId,
      "tool-call-2",
      "Second tool call ID should replace the first"
    );
  }
);

add_task(function test_addUIToolToCurrentMessage_emits_events() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Test prompt", null);
  conversation.addAssistantMessage("text", "Response");

  let updateEventFired = false;
  let completeEventFired = false;

  conversation.on("chat-conversation:message-update", () => {
    updateEventFired = true;
  });
  conversation.on("chat-conversation:message-complete", () => {
    completeEventFired = true;
  });

  conversation.addUIToolToCurrentMessage("tool-call-event", {
    uiType: "test-ui",
  });

  Assert.ok(updateEventFired, "Update event should be emitted");
  Assert.ok(completeEventFired, "Complete event should be re-emitted");
});

add_task(async function test_addUserMessage_dismisses_prior_undo() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Close my tabs", "https://example.com/", 0);
  conversation.addAssistantMessage("text", "Closed");

  const assistant = conversation.messages.at(-1);
  assistant.toolUIData = {
    toolCallId: "t1",
    uiType: "ai-action-result",
    properties: { confirmedData: { operationId: "op-1" } },
  };

  // User sends a new message
  conversation.addUserMessage("show my history", "https://example.com/", 0);

  Assert.equal(
    assistant.toolUIData.properties.confirmedData.operationId,
    "op-1",
    "Dismissal preserves other property keys"
  );
  Assert.strictEqual(
    assistant.toolUIData.properties.undoDismissed,
    true,
    "Prior ai-action-result with active operationId gets undoDismissed on follow-up"
  );
});

add_task(async function test_dismissPendingUndos_skips_without_operationId() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Close my tabs", "https://example.com/", 0);
  conversation.addAssistantMessage("text", "Closed");

  const assistant = conversation.messages.at(-1);
  assistant.toolUIData = {
    toolCallId: "t1",
    uiType: "ai-action-result",
    properties: { confirmedData: {} },
  };

  conversation.addUserMessage("show my history", "https://example.com/", 0);

  Assert.ok(
    !assistant.toolUIData.properties.undoDismissed,
    "ai-action-result without operationId is not dismissed"
  );
});

add_task(async function test_dismissPendingUndos_only_dismisses_most_recent() {
  const conversation = new ChatConversation({});

  conversation.addUserMessage("Close A", "https://example.com/", 0);
  conversation.addAssistantMessage("text", "Closed A");
  const olderAssistant = conversation.messages.at(-1);

  conversation.addAssistantMessage("text", "Closed B");
  const newerAssistant = conversation.messages.at(-1);

  // Set toolUIData on both before the next user message triggers undoDismissed
  olderAssistant.toolUIData = {
    toolCallId: "t1",
    uiType: "ai-action-result",
    properties: { confirmedData: { operationId: "op-older" } },
  };
  newerAssistant.toolUIData = {
    toolCallId: "t2",
    uiType: "ai-action-result",
    properties: { confirmedData: { operationId: "op-newer" } },
  };

  conversation.addUserMessage("show my history", "https://example.com/", 0);

  Assert.withSoftAssertions(function (soft) {
    soft.strictEqual(
      newerAssistant.toolUIData.properties.undoDismissed,
      true,
      "Most recent qualifying card is dismissed"
    );
    soft.ok(
      !olderAssistant.toolUIData.properties.undoDismissed,
      "Older qualifying card is left untouched"
    );
  });
});

add_task(function test_addToolCallMessage_emits_message_update() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Get opened tabs", null);

  let received = null;
  let calls = 0;
  conversation.on("chat-conversation:message-update", (_event, msg) => {
    if (msg?.role === MESSAGE_ROLE.TOOL) {
      received = msg;
      calls++;
    }
  });

  const toolMessage = conversation.addToolCallMessage({
    tool_call_id: "tc_abc",
    body: [{ url: "https://example.com/", title: "Example" }],
    name: "get_open_tabs",
  });

  Assert.withSoftAssertions(function (soft) {
    soft.equal(
      calls,
      1,
      "Update event fires exactly once for the tool message"
    );
    soft.strictEqual(
      received,
      toolMessage,
      "Event payload is the newly added tool message"
    );
    soft.equal(
      received?.content?.name,
      "get_open_tabs",
      "tool message carries the tool name"
    );
    soft.equal(
      received?.content?.tool_call_id,
      "tc_abc",
      "tool message carries the tool_call_id"
    );
  });
});

add_task(function test_addToolCallMessage_emits_for_error_payload() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("Anything", null);

  let received = null;
  conversation.on("chat-conversation:message-update", (_event, msg) => {
    if (msg?.role === MESSAGE_ROLE.TOOL) {
      received = msg;
    }
  });

  conversation.addToolCallMessage({
    tool_call_id: "tc_err",
    body: { error: "Invalid JSON arguments" },
  });

  Assert.ok(received, "Error-path TOOL message still emits the event");
  Assert.equal(
    received.content.name,
    undefined,
    "Error-path TOOL message has no name field"
  );
});

add_task(function test_resolvePendingToolConfirmation_no_messages() {
  const conversation = new ChatConversation({});
  Assert.equal(
    conversation.resolvePendingToolConfirmation({ description: "x" }, "tc-1"),
    false,
    "Returns false when there are no messages"
  );
});

add_task(function test_resolvePendingToolConfirmation_non_tool_message() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("hi", null);
  conversation.addAssistantMessage("text", "hello");

  Assert.equal(
    conversation.resolvePendingToolConfirmation({ description: "x" }, "tc-1"),
    false,
    "Returns false when last message is not a TOOL message"
  );
});

add_task(function test_resolvePendingToolConfirmation_tool_not_pending() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("hi", null);
  conversation.addAssistantMessage("text", "hello");
  conversation.addToolCallMessage({
    tool_call_id: "tc-1",
    name: "manage_tabs",
    body: { success: true },
  });

  Assert.equal(
    conversation.resolvePendingToolConfirmation({ description: "x" }, "tc-1"),
    false,
    "Returns false when the tool body is not pending"
  );
});

add_task(function test_resolvePendingToolConfirmation_toolCallId_mismatch() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("close my tabs", null);
  conversation.addAssistantMessage("text", "confirm?");
  conversation.addToolCallMessage({
    tool_call_id: "tc-1",
    name: "manage_tabs",
    body: { pending: true },
  });

  const noopResolved = conversation.resolvePendingToolConfirmation(
    { description: "mismatch" },
    "tc-other"
  );
  Assert.equal(
    noopResolved,
    false,
    "Returns false when toolCallId does not match the most recent tool message"
  );
  Assert.deepEqual(
    conversation.messages.at(-1).content.body,
    { pending: true },
    "Body should remain unchanged when toolCallId does not match"
  );

  const okResolved = conversation.resolvePendingToolConfirmation(
    { description: "match" },
    "tc-1"
  );
  Assert.equal(
    okResolved,
    true,
    "Returns true when toolCallId filter matches the tail"
  );
});

add_task(function test_resolvePendingToolConfirmation_resolves_pending_tail() {
  const conversation = new ChatConversation({});
  conversation.addUserMessage("close my tabs", null);
  conversation.addAssistantMessage("text", "confirm?");
  conversation.addToolCallMessage({
    tool_call_id: "tc-1",
    name: "manage_tabs",
    body: { pending: true, action: "close" },
  });

  const tailBefore = conversation.messages.at(-1);

  let emittedMessage = null;
  conversation.on("chat-conversation:message-update", (_event, m) => {
    emittedMessage = m;
  });

  const outcome = { description: "User confirmed." };
  const resolved = conversation.resolvePendingToolConfirmation(outcome, "tc-1");

  Assert.equal(resolved, true, "Returns true when a pending tail is resolved");
  const tailAfter = conversation.messages.at(-1);
  Assert.strictEqual(
    tailAfter,
    tailBefore,
    "Resolves in place rather than appending a new message"
  );
  Assert.deepEqual(
    tailAfter.content.body,
    outcome,
    "Body is replaced with the supplied outcome"
  );
  Assert.equal(
    tailAfter.content.tool_call_id,
    "tc-1",
    "Other content keys are preserved"
  );
  Assert.equal(
    emittedMessage,
    tailAfter,
    "Emits chat-conversation:message-update with the resolved tail message"
  );
});
