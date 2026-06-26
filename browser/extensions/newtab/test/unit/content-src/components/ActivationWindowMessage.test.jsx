import { ActivationWindowMessage } from "content-src/components/ActivationWindowMessage/ActivationWindowMessage";
import React from "react";
import { shallow } from "enzyme";

describe("<ActivationWindowMessage>", () => {
  let sandbox;
  let handleBlock;
  let handleClick;
  let handleDismiss;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    handleBlock = sandbox.stub();
    handleClick = sandbox.stub();
    handleDismiss = sandbox.stub();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("should render with correct structure for hardcoded strings", () => {
    const messageData = {
      content: {
        heading: "Test Heading",
        message: "Test Message",
        imageSrc: "chrome://test/image.png",
        primaryButton: { label: "Primary", action: {} },
        secondaryButton: { label: "Secondary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.ok(wrapper.find("aside.activation-window-message").exists());

    const img = wrapper.find("img");
    assert.ok(img.exists());
    assert.equal(img.prop("src"), "chrome://test/image.png");

    const heading = wrapper.find("h2");
    assert.ok(heading.exists());
    assert.equal(heading.text(), "Test Heading");
    assert.isUndefined(heading.prop("data-l10n-id"));

    const message = wrapper.find("p");
    assert.ok(message.exists());
    assert.equal(message.text(), "Test Message");
    assert.isUndefined(message.prop("data-l10n-id"));
  });

  it("should render heading with Fluent ID", () => {
    const messageData = {
      content: {
        heading: { string_id: "test-heading-id" },
        message: "Test Message",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const heading = wrapper.find("h2");
    assert.ok(heading.exists());
    assert.equal(heading.prop("data-l10n-id"), "test-heading-id");
    assert.equal(heading.text(), "");
  });

  it("should render message with Fluent ID", () => {
    const messageData = {
      content: {
        heading: "Test Heading",
        message: { string_id: "test-message-id" },
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const message = wrapper.find("p");
    assert.ok(message.exists());
    assert.equal(message.prop("data-l10n-id"), "test-message-id");
    assert.equal(message.text(), "");
  });

  it("should render dismiss button", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const dismissButton = wrapper.find("moz-button[type='icon ghost']");
    assert.ok(dismissButton.exists());
    assert.equal(
      dismissButton.prop("iconSrc"),
      "chrome://global/skin/icons/close.svg"
    );
    assert.equal(
      dismissButton.prop("data-l10n-id"),
      "newtab-activation-window-message-dismiss-button"
    );
  });

  it("should call handleDismiss and handleBlock when dismiss button is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='icon ghost']").simulate("click");
    assert.calledOnce(handleDismiss);
    assert.calledOnce(handleBlock);
  });

  it("should render fallback image if imageSrc not provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const img = wrapper.find("img");
    assert.ok(img.exists());
    assert.equal(img.prop("src"), "chrome://branding/content/about-logo.svg");
    assert.equal(img.prop("role"), "presentation");
  });

  it("should render primary button with plain text label", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Click Me", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const primaryButton = wrapper.find("moz-button[type='primary']");
    assert.ok(primaryButton.exists());
    assert.equal(primaryButton.text(), "Click Me");
    assert.isUndefined(primaryButton.prop("data-l10n-id"));
  });

  it("should render primary button with Fluent ID", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: {
          label: { string_id: "test-primary-button" },
          action: {},
        },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const primaryButton = wrapper.find("moz-button[type='primary']");
    assert.ok(primaryButton.exists());
    assert.equal(primaryButton.prop("data-l10n-id"), "test-primary-button");
    assert.equal(primaryButton.text(), "");
  });

  it("should render secondary button with plain text label", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        secondaryButton: { label: "Dismiss", action: { dismiss: true } },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const secondaryButton = wrapper.find("moz-button[type='default']");
    assert.ok(secondaryButton.exists());
    assert.equal(secondaryButton.text(), "Dismiss");
    assert.isUndefined(secondaryButton.prop("data-l10n-id"));
  });

  it("should render secondary button with Fluent ID", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        secondaryButton: {
          label: { string_id: "test-secondary-button" },
          action: { dismiss: true },
        },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const secondaryButton = wrapper.find("moz-button[type='default']");
    assert.ok(secondaryButton.exists());
    assert.equal(secondaryButton.prop("data-l10n-id"), "test-secondary-button");
    assert.equal(secondaryButton.text(), "");
  });

  it("should not render primary button if not provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        secondaryButton: { label: "Dismiss", action: { dismiss: true } },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.isFalse(wrapper.find("moz-button[type='primary']").exists());
  });

  it("should not render secondary button if not provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Click", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.isFalse(wrapper.find("moz-button[type='default']").exists());
  });

  it("should not render moz-button-group if no buttons provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.isFalse(wrapper.find("moz-button-group").exists());
  });

  it("should apply no-buttons class when no buttons provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.ok(
      wrapper.find("aside").hasClass("activation-window-message no-buttons")
    );
  });

  it("should not apply no-buttons class when buttons are provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    assert.equal(
      wrapper.find("aside").prop("className"),
      "activation-window-message"
    );
  });

  it("should render image with role presentation when imageSrc is provided", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        imageSrc: "chrome://test/image.png",
        primaryButton: { label: "Primary", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    const img = wrapper.find("img");
    assert.ok(img.exists());
    assert.equal(img.prop("src"), "chrome://test/image.png");
    assert.equal(img.prop("role"), "presentation");
  });

  it("should call handleClick when primary button is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Click", action: {} },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='primary']").simulate("click");
    assert.calledOnce(handleClick);
    assert.calledWith(handleClick, "primary-button");
  });

  it("should call handleClick when secondary button is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        secondaryButton: { label: "Dismiss", action: { dismiss: true } },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='default']").simulate("click");
    assert.calledOnce(handleClick);
    assert.calledWith(handleClick, "secondary-button");
  });

  it("should call handleDismiss and handleBlock when primary button with dismiss action is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: { label: "Got It", action: { dismiss: true } },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='primary']").simulate("click");
    assert.calledOnce(handleClick);
    assert.calledOnce(handleDismiss);
    assert.calledOnce(handleBlock);
  });

  it("should call handleDismiss and handleBlock when secondary button with dismiss action is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        secondaryButton: { label: "Dismiss", action: { dismiss: true } },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='default']").simulate("click");
    assert.calledOnce(handleClick);
    assert.calledOnce(handleDismiss);
    assert.calledOnce(handleBlock);
  });

  it("should not call handleDismiss or handleBlock when button without dismiss action is clicked", () => {
    const messageData = {
      content: {
        heading: "Test",
        message: "Test",
        primaryButton: {
          label: "Learn More",
          action: { type: "OPEN_URL", data: {} },
        },
      },
    };

    const wrapper = shallow(
      <ActivationWindowMessage
        handleBlock={handleBlock}
        handleClick={handleClick}
        handleDismiss={handleDismiss}
        messageData={messageData}
      />
    );

    wrapper.find("moz-button[type='primary']").simulate("click");
    assert.calledOnce(handleClick);
    assert.notCalled(handleDismiss);
    assert.notCalled(handleBlock);
  });
});
