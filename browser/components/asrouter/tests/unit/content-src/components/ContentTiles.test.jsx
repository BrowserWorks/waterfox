import React from "react";
import { shallow, mount } from "enzyme";
import { ContentTiles } from "content-src/components/ContentTiles";
import { ActionChecklist } from "content-src/components/ActionChecklist";
import { MobileDownloads } from "content-src/components/MobileDownloads";
import { EmbeddedBackupRestore } from "content-src/components/EmbeddedBackupRestore";
import { EmbeddedMigrationWizard } from "content-src/components/EmbeddedMigrationWizard";
import { TextBoxTile } from "content-src/components/TextBoxTile";
import { ContentToggle } from "content-src/components/ContentToggle";
import { MultiStageUtils } from "content-src/lib/multistage-utils.mjs";
import { GlobalOverrider } from "tests/unit/utils";

describe("ContentTiles component", () => {
  let sandbox;
  let wrapper;
  let handleAction;
  let setActiveMultiSelect;
  let setActiveSingleSelectSelection;
  let globals;

  const CHECKLIST_TILE = {
    type: "action_checklist",
    header: {
      title: "Checklist Header",
      subtitle: "Checklist Subtitle",
      style: {
        border: "1px solid #ccc",
      },
    },
    data: [
      {
        id: "action-checklist-test",
        targeting: "false",
        label: {
          raw: "Test label",
        },
        action: {
          data: {
            pref: {
              name: "messaging-system-action.test1",
              value: "false",
            },
          },
          type: "SET_PREF",
        },
      },
    ],
  };

  const MOBILE_TILE = {
    type: "mobile_downloads",
    header: {
      title: "Mobile Header",
      style: {
        backgroundColor: "#e0e0e0",
        border: "1px solid #999",
      },
    },
    data: {
      email: {
        link_text: "Email yourself a link",
      },
    },
  };

  const TITLE_TILE = {
    type: "mobile_downloads",
    title: "Tile Title",
    subtitle: "Tile Subtitle",
    data: {
      email: {
        link_text: "Email yourself a link",
      },
    },
  };

  const TEST_CONTENT = {
    tiles: [CHECKLIST_TILE, MOBILE_TILE],
  };

  const EMBEDDED_BACKUP_RESTORE_TILE = {
    type: "backup_restore",
    title: "Tile Title",
    subtitle: "Tile Subtitle",
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    handleAction = sandbox.stub();
    setActiveMultiSelect = sandbox.stub();
    setActiveSingleSelectSelection = sandbox.stub();
    globals = new GlobalOverrider();
    globals.set({
      AWSendToDeviceEmailsSupported: () => Promise.resolve(),
    });
    globals.set({ AWSendToParent: sandbox.stub() });
    globals.set({
      AWSendToParent: sandbox.stub(),
      AWFindBackupsInWellKnownLocations: sandbox.stub().resolves({
        found: false,
        multipleBackupsFound: false,
        backupFileToRestore: null,
      }),
    });
    wrapper = shallow(
      <ContentTiles
        content={TEST_CONTENT}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );
  });

  afterEach(() => {
    sandbox.restore();
    globals.restore();
  });

  it("should render the component when tiles are provided", () => {
    assert.ok(wrapper.exists());
  });

  it("should not render the component when no tiles are provided", () => {
    wrapper.setProps({ content: {} });
    assert.ok(wrapper.isEmptyRender());
  });

  it("should render the correct number of tiles", () => {
    assert.equal(wrapper.find(".content-tile").length, 2);
  });

  it("should toggle a tile and send telemetry when its header is clicked", () => {
    let telemetrySpy = sandbox.spy(MultiStageUtils, "sendActionTelemetry");
    const [firstTile] = TEST_CONTENT.tiles;
    const tileId = `${firstTile.type}${firstTile.id ? "_" : ""}${
      firstTile.id ?? ""
    }_header`;
    const firstTileButton = wrapper.find(".tile-header").at(0);
    firstTileButton.simulate("click");
    assert.equal(
      wrapper.find(".tile-content").at(0).prop("id"),
      "tile-content-0"
    );
    assert.equal(wrapper.find(".tile-content").at(0).exists(), true);
    assert.calledOnce(telemetrySpy);
    assert.equal(telemetrySpy.firstCall.args[1], tileId);
  });

  it("should only expand one tile at a time", () => {
    const firstTileButton = wrapper.find(".tile-header").at(0);
    firstTileButton.simulate("click");
    const secondTileButton = wrapper.find(".tile-header").at(1);
    secondTileButton.simulate("click");

    assert.equal(wrapper.find(".tile-content").length, 1);
    assert.equal(
      wrapper.find(".tile-content").at(0).prop("id"),
      "tile-content-1"
    );
  });

  it("should toggle all tiles and send telemetry when the tiles header is clicked", () => {
    const TEST_CONTENT_HEADER = {
      tiles: [CHECKLIST_TILE, MOBILE_TILE],
      tiles_header: {
        title: "Toggle Tiles Header",
      },
    };

    wrapper = mount(
      <ContentTiles
        content={TEST_CONTENT_HEADER}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    let telemetrySpy = sandbox.spy(MultiStageUtils, "sendActionTelemetry");
    const tilesHeaderButton = wrapper.find(".content-tiles-header");

    assert.ok(tilesHeaderButton.exists(), "Tiles header button should exist");
    tilesHeaderButton.simulate("click");

    assert.equal(
      wrapper.find("#content-tiles-container").exists(),
      true,
      "Content tiles container should be visible after toggle"
    );
    assert.calledOnce(telemetrySpy);
    assert.equal(
      telemetrySpy.firstCall.args[1],
      "content_tiles_header",
      "Telemetry should be sent for tiles header toggle"
    );

    tilesHeaderButton.simulate("click");
    assert.equal(
      wrapper.find("#content-tiles-container").exists(),
      false,
      "Content tiles container should not be visible after second toggle"
    );
  });

  it("should apply configured styles to the header buttons", () => {
    const mountedWrapper = mount(
      <ContentTiles
        content={TEST_CONTENT}
        handleAction={() => {}}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const firstTileHeader = mountedWrapper
      .find(".tile-header")
      .at(0)
      .getDOMNode();
    const secondTileHeader = mountedWrapper
      .find(".tile-header")
      .at(1)
      .getDOMNode();

    assert.equal(
      firstTileHeader.style.cssText,
      "border: 1px solid rgb(204, 204, 204);",
      "First tile header styles should match configured values"
    );
    assert.equal(
      secondTileHeader.style.cssText,
      "background-color: rgb(224, 224, 224); border: 1px solid rgb(153, 153, 153);",
      "Second tile header styles should match configured values"
    );

    mountedWrapper.unmount();
  });

  it("should render ActionChecklist for 'action_checklist' tile type", () => {
    const firstTileButton = wrapper.find(".tile-header").at(0);
    assert.ok(firstTileButton.exists(), "Tile header button should exist");
    firstTileButton.simulate("click");

    const actionChecklist = wrapper.find(ActionChecklist);
    assert.ok(actionChecklist.exists());
    assert.deepEqual(actionChecklist.prop("content").tiles[0].data, [
      {
        id: "action-checklist-test",
        targeting: "false",
        label: {
          raw: "Test label",
        },
        action: {
          data: {
            pref: {
              name: "messaging-system-action.test1",
              value: "false",
            },
          },
          type: "SET_PREF",
        },
      },
    ]);
  });

  it("should render MobileDownloads for 'mobile_downloads' tile type", () => {
    const secondTileButton = wrapper.find(".tile-header").at(1);
    assert.ok(secondTileButton.exists(), "Tile header button should exist");
    secondTileButton.simulate("click");

    const mobileDownloads = wrapper.find(MobileDownloads);
    assert.ok(mobileDownloads.exists());
    assert.deepEqual(mobileDownloads.prop("data"), {
      email: {
        link_text: "Email yourself a link",
      },
    });
    assert.equal(mobileDownloads.prop("handleAction"), handleAction);
  });

  it("should render EmbeddedBackupRestore for 'backup_restore' tile type", () => {
    const TEST_CONTENT_WITH_EMBEDDED_BACKUP_RESTORE = {
      tiles: [EMBEDDED_BACKUP_RESTORE_TILE],
    };

    const backupWrapper = mount(
      <ContentTiles
        content={TEST_CONTENT_WITH_EMBEDDED_BACKUP_RESTORE}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const embeddedBackupRestore = backupWrapper.find(EmbeddedBackupRestore);
    assert.ok(
      embeddedBackupRestore.exists(),
      "EmbeddedBackupRestore component should be rendered"
    );

    backupWrapper.unmount();
  });

  it("should handle a single tile object", () => {
    wrapper.setProps({
      content: {
        tiles: {
          type: "action_checklist",
          data: [
            {
              id: "action-checklist-single",
              targeting: "false",
              label: {
                raw: "Single tile label",
              },
              action: {
                data: {
                  pref: {
                    name: "messaging-system-action.single",
                    value: "false",
                  },
                },
                type: "SET_PREF",
              },
            },
          ],
        },
      },
    });

    const actionChecklist = wrapper.find(ActionChecklist);
    assert.ok(actionChecklist.exists());
    assert.deepEqual(actionChecklist.prop("content").tiles.data, [
      {
        id: "action-checklist-single",
        targeting: "false",
        label: {
          raw: "Single tile label",
        },
        action: {
          data: {
            pref: {
              name: "messaging-system-action.single",
              value: "false",
            },
          },
          type: "SET_PREF",
        },
      },
    ]);
  });

  it("should prefill activeMultiSelect for a MultiSelect tile based on default values", () => {
    const MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "Multiselect Header",
        style: {
          border: "1px solid #ddd",
        },
      },
      data: [
        { id: "option1", defaultValue: true },
        { id: "option2", defaultValue: false },
        { id: "option3", defaultValue: true },
      ],
    };

    const contentWithMultiselect = { tiles: MULTISELECT_TILE };

    wrapper = mount(
      <ContentTiles
        content={contentWithMultiselect}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        handleAction={handleAction}
      />
    );
    wrapper.update();

    sinon.assert.calledOnce(setActiveMultiSelect);
    sinon.assert.calledWithExactly(
      setActiveMultiSelect,
      ["option1", "option3"],
      "tile-0"
    );
  });

  it("should not prefill activeMultiSelect if it is already set", () => {
    const MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "Multiselect Header",
        style: {
          border: "1px solid #ddd",
        },
      },
      data: [
        { id: "option1", defaultValue: true },
        { id: "option2", defaultValue: false },
        { id: "option3", defaultValue: true },
      ],
    };

    const contentWithMultiselect = { tiles: [MULTISELECT_TILE] };

    wrapper = mount(
      <ContentTiles
        content={contentWithMultiselect}
        activeMultiSelect={["option2"]}
        setActiveMultiSelect={setActiveMultiSelect}
        handleAction={handleAction}
      />
    );
    wrapper.update();

    sinon.assert.notCalled(setActiveMultiSelect);
  });

  it("should render title and subtitle if present", () => {
    sandbox.stub(window, "AWSendToDeviceEmailsSupported").resolves(true);

    let TEST_TILE_CONTENT = {
      tiles: [TITLE_TILE],
    };

    const mountedWrapper = mount(
      <ContentTiles
        content={TEST_TILE_CONTENT}
        handleAction={() => {}}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const tileTitle = mountedWrapper.find(".tile-title");
    const tileSubtitle = mountedWrapper.find(".tile-subtitle");

    assert.ok(tileTitle.exists(), "Title should render");
    assert.ok(tileSubtitle.exists(), "Subtitle should render");

    assert.equal(
      tileTitle.text(),
      "Tile Title",
      "Tile title should have correct text"
    );
    assert.equal(
      tileSubtitle.text(),
      "Tile Subtitle",
      "Tile subtitle should have correct text"
    );

    mountedWrapper.unmount();
  });

  it("should render multiple title and subtitles if multiple tiles contain them", () => {
    sandbox.stub(window, "AWSendToDeviceEmailsSupported").resolves(true);
    const SECOND_TITLE_TILE = {
      type: "mobile_downloads",
      title: "Tile Title 2",
      subtitle: "Tile Subtitle 2",
      data: {
        email: {
          link_text: "Email yourself a link",
        },
      },
    };

    let MULTIPLE_TILES_CONTENT = {
      tiles: [TITLE_TILE, SECOND_TITLE_TILE],
    };

    const mountedWrapper = mount(
      <ContentTiles
        content={MULTIPLE_TILES_CONTENT}
        handleAction={() => {}}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        setActiveSingleSelectSelection={setActiveSingleSelectSelection}
      />
    );

    const tileTitles = mountedWrapper.find(".tile-title");
    const tileSubtitles = mountedWrapper.find(".tile-subtitle");

    assert.equal(tileTitles.length, 2, "Should render two tile titles");
    assert.equal(tileSubtitles.length, 2, "Should render two tile subtitles");

    assert.equal(
      tileTitles.at(0).text(),
      "Tile Title",
      "First tile title should have correct text"
    );
    assert.equal(
      tileSubtitles.at(0).text(),
      "Tile Subtitle",
      "First tile subtitle should have correct text"
    );

    assert.equal(
      tileTitles.at(1).text(),
      "Tile Title 2",
      "Second tile title should have correct text"
    );
    assert.equal(
      tileSubtitles.at(1).text(),
      "Tile Subtitle 2",
      "Second tile subtitle should have correct text"
    );

    mountedWrapper.unmount();
  });

  it("should pre-populate multiple MultiSelect components in the same ContentTiles independently of one another", () => {
    const FIRST_MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "First Multiselect",
      },
      data: [
        { id: "checklist1-option1", defaultValue: true },
        { id: "checklist1-option2", defaultValue: false },
      ],
    };

    const SECOND_MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "Second Multiselect",
      },
      data: [
        { id: "checklist2-option1", defaultValue: false },
        { id: "checklist2-option2", defaultValue: true },
      ],
    };

    const contentWithMultipleMultiselects = {
      tiles: [FIRST_MULTISELECT_TILE, SECOND_MULTISELECT_TILE],
    };

    wrapper = mount(
      <ContentTiles
        content={contentWithMultipleMultiselects}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        handleAction={handleAction}
      />
    );
    wrapper.update();

    sinon.assert.calledWithExactly(
      setActiveMultiSelect.getCall(0),
      ["checklist1-option1"],
      "tile-0"
    );
    sinon.assert.calledWithExactly(
      setActiveMultiSelect.getCall(1),
      ["checklist2-option2"],
      "tile-1"
    );

    wrapper.unmount();
  });

  it("should handle interaction between multiselect instances independently of one another", () => {
    const FIRST_MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "First Multiselect",
      },
      data: [
        { id: "checklist1-option1", defaultValue: true, label: "Option 1-1" },
        { id: "checklist1-option2", defaultValue: false, label: "Option 1-2" },
      ],
    };

    const SECOND_MULTISELECT_TILE = {
      type: "multiselect",
      header: {
        title: "Second Multiselect",
      },
      data: [
        { id: "checklist2-option1", defaultValue: false, label: "Option 2-1" },
        { id: "checklist2-option2", defaultValue: true, label: "Option 2-2" },
      ],
    };

    const contentWithMultipleMultiselects = {
      tiles: [FIRST_MULTISELECT_TILE, SECOND_MULTISELECT_TILE],
    };

    const initialActiveMultiSelect = {
      "tile-0": ["checklist1-option1"],
      "tile-1": ["checklist2-option2"],
    };

    const setScreenMultiSelects = sandbox.stub();

    wrapper = mount(
      <ContentTiles
        content={contentWithMultipleMultiselects}
        activeMultiSelect={initialActiveMultiSelect}
        setActiveMultiSelect={setActiveMultiSelect}
        setScreenMultiSelects={setScreenMultiSelects}
        handleAction={handleAction}
      />
    );

    // First multiselect
    const firstTileButton = wrapper.find(".tile-header").at(0);
    assert.ok(firstTileButton.exists(), "First tile header should exist");
    firstTileButton.simulate("click");

    const firstChecklistInputs = wrapper.find(".multi-select-container input");
    assert.equal(
      firstChecklistInputs.length,
      2,
      "First checklist should have 2 inputs"
    );

    assert.equal(
      firstChecklistInputs.at(0).prop("checked"),
      true,
      "First option should be checked"
    );
    assert.equal(
      firstChecklistInputs.at(1).prop("checked"),
      false,
      "Second option should be unchecked"
    );

    const secondInput = firstChecklistInputs.at(1);
    secondInput.getDOMNode().checked = true;
    secondInput.simulate("change");

    sinon.assert.calledOnce(setActiveMultiSelect);
    sinon.assert.calledWithExactly(
      setActiveMultiSelect,
      ["checklist1-option1", "checklist1-option2"],
      "tile-0"
    );
    setActiveMultiSelect.reset();

    // Second multiSelect
    const secondTileButton = wrapper.find(".tile-header").at(1);
    secondTileButton.simulate("click");

    const secondChecklistInputs = wrapper.find(".multi-select-container input");
    assert.equal(
      secondChecklistInputs.length,
      2,
      "Second checklist should have 2 inputs"
    );

    assert.equal(
      secondChecklistInputs.at(0).prop("checked"),
      false,
      "First option should be unchecked"
    );
    assert.equal(
      secondChecklistInputs.at(1).prop("checked"),
      true,
      "Second option should be checked"
    );

    // Uncheck the second checkbox in the second multiselect
    const lastInput = secondChecklistInputs.at(1);
    lastInput.getDOMNode().checked = false;
    lastInput.simulate("change");

    sinon.assert.calledOnce(setActiveMultiSelect);
    sinon.assert.calledWithExactly(setActiveMultiSelect, [], "tile-1");

    // Ensure the first multiselect's state wasn't altered by changes to the second multiselect
    wrapper.setProps({
      activeMultiSelect: {
        "tile-0": ["checklist1-option1", "checklist1-option2"],
        "tile-1": [],
      },
    });

    firstTileButton.simulate("click");

    // Get the updated checkboxes from the first checklist
    const updatedFirstInputs = wrapper.find(".multi-select-container input");

    assert.equal(
      updatedFirstInputs.at(0).prop("checked"),
      true,
      "First option should still be checked"
    );
    assert.equal(
      updatedFirstInputs.at(1).prop("checked"),
      true,
      "Second option should still be checked"
    );

    wrapper.unmount();
  });

  it("should select defaults of single select tiles independently of one another", () => {
    const SINGLE_SELECT_1 = {
      type: "single-select",
      legend: { raw: "First picker" },
      selected: "test1",
      data: [
        {
          id: "test1",
          label: {
            raw: "test1 label",
          },
        },
        {
          defaultValue: true,
          id: "test2",
          label: {
            raw: "test2 label",
          },
        },
      ],
    };

    const SINGLE_SELECT_2 = {
      type: "single-select",
      selected: "test4",
      data: [
        {
          id: "test3",
          label: {
            raw: "test3 label",
          },
        },
        {
          defaultValue: true,
          id: "test4",
          label: {
            raw: "test4 label",
          },
        },
      ],
    };

    const content = {
      subtitle: { raw: "Parent picker" },
      tiles: [SINGLE_SELECT_1, SINGLE_SELECT_2],
    };
    wrapper = mount(
      <ContentTiles
        content={content}
        setActiveSingleSelectSelection={setActiveSingleSelectSelection}
        handleAction={handleAction}
      />
    );
    wrapper.update();

    const fieldsets = wrapper.find("fieldset");
    assert.deepEqual(
      fieldsets
        .at(0)
        .find('input[type="radio"]')
        .map(input => input.prop("name")),
      ["single-select-0", "single-select-0"]
    );
    assert.deepEqual(
      fieldsets
        .at(1)
        .find('input[type="radio"]')
        .map(input => input.prop("name")),
      ["single-select-1", "single-select-1"]
    );
    assert.notEqual(
      fieldsets.at(0).find("input").at(0).prop("name"),
      fieldsets.at(1).find("input").at(0).prop("name")
    );
    assert.equal(fieldsets.at(0).find("legend").text(), "First picker");
    assert.equal(fieldsets.at(1).find("legend").text(), "Parent picker");

    sinon.assert.calledWithExactly(
      setActiveSingleSelectSelection.getCall(0),
      "test1",
      "single-select-0"
    );

    sinon.assert.calledWithExactly(
      setActiveSingleSelectSelection.getCall(1),
      "test4",
      "single-select-1"
    );
    wrapper.unmount();
  });

  it("should give tile buttons unique IDs and telemetry sources", () => {
    const content = {
      subtitle: { raw: "Picker" },
      tiles: {
        type: "single-select",
        selected: "first",
        data: [
          {
            id: "first",
            label: { raw: "First" },
            tilebutton: {
              label: { raw: "First action" },
              action: { type: "FIRST_ACTION" },
            },
          },
          {
            id: "second",
            label: { raw: "Second" },
            tilebutton: {
              label: { raw: "Second action" },
              action: { type: "SECOND_ACTION" },
            },
          },
        ],
      },
    };
    wrapper = mount(
      <ContentTiles
        content={content}
        setActiveSingleSelectSelection={setActiveSingleSelectSelection}
        handleAction={handleAction}
      />
    );

    const tileButtons = wrapper.find("button.tile-button");
    assert.deepEqual(
      tileButtons.map(button => button.prop("id")),
      [
        "tile-button-single-select-0-first",
        "tile-button-single-select-0-second",
      ]
    );

    tileButtons.at(0).simulate("click", {
      target: { id: "tile-button-single-select-0-first" },
    });
    tileButtons.at(1).simulate("click", {
      target: { id: "tile-button-single-select-0-second" },
    });

    assert.equal(
      handleAction.getCall(0).args[0].source,
      "tile-button-single-select-0-first"
    );
    assert.equal(
      handleAction.getCall(1).args[0].source,
      "tile-button-single-select-0-second"
    );
    wrapper.unmount();
  });

  it("should handle interactions with multiple single select tiles independently of one another", () => {
    const SINGLE_SELECT_1 = {
      type: "single-select",
      selected: "test1",
      data: [
        {
          id: "test1",
          label: {
            raw: "test1 label",
          },
        },
        {
          defaultValue: true,
          id: "test2",
          label: {
            raw: "test2 label",
          },
        },
      ],
    };

    const SINGLE_SELECT_2 = {
      type: "single-select",
      selected: "test4",
      data: [
        {
          id: "test3",
          label: {
            raw: "test3 label",
          },
        },
        {
          defaultValue: true,
          id: "test4",
          label: {
            raw: "test4 label",
          },
        },
      ],
    };

    const content = { tiles: [SINGLE_SELECT_1, SINGLE_SELECT_2] };
    wrapper = mount(
      <ContentTiles
        content={content}
        setActiveSingleSelectSelection={setActiveSingleSelectSelection}
        handleAction={handleAction}
      />
    );

    wrapper.update();

    const tile2 = wrapper.find('input[value="test2"]');
    tile2.simulate("click");

    sinon.assert.calledWithExactly(
      setActiveSingleSelectSelection.getCall(2),
      "test2",
      "single-select-0"
    );

    const tile3 = wrapper.find('input[value="test3"]');
    tile3.simulate("click");

    sinon.assert.calledWithExactly(
      setActiveSingleSelectSelection.getCall(3),
      "test3",
      "single-select-1"
    );
    wrapper.unmount();
  });

  it("should apply styles to label element", () => {
    const TEST_STYLE = { marginBlock: "5px" };
    const tileData = {
      type: "single-select",
      selected: "vertical",
      data: [
        {
          id: "vertical",
          label: { raw: "Vertical", marginBlock: "5px" },
        },
      ],
    };

    wrapper = mount(
      <ContentTiles
        content={{ tiles: [tileData] }}
        setActiveSingleSelectSelection={() => {}}
        handleAction={() => {}}
      />
    );

    const styledDiv = wrapper.find(".text").at(0);

    assert.deepEqual(
      styledDiv.prop("style"),
      TEST_STYLE,
      "Style prop should match TEST_STYLE"
    );
    wrapper.unmount();
  });

  it("should apply valid styles from tile.data.style and include minWidth from icon.width", () => {
    const icon = {
      width: "101px",
    };

    const style = {
      paddingBlock: "8px",
    };

    const tileData = {
      type: "single-select",
      selected: "test",
      data: [
        {
          id: "test",
          icon,
          label: { raw: "Test" },
          style,
        },
      ],
    };

    wrapper = mount(
      <ContentTiles
        content={{ tiles: [tileData] }}
        setActiveSingleSelectSelection={() => {}}
        handleAction={() => {}}
      />
    );

    const label = wrapper.find("label.select-item").at(0);
    const labelStyle = label.prop("style");

    assert.equal(
      labelStyle.paddingBlock,
      "8px",
      "paddingBlock should be applied"
    );
    assert.equal(
      labelStyle.minWidth,
      "101px",
      "minWidth should be set from icon.width"
    );
    wrapper.unmount();
  });

  it("restores last tiles focus in Spotlight context and genuine Tab is ignored", async () => {
    const TAB_GRACE_WINDOW_MS = 250;

    function nextFrame() {
      return new Promise(r => requestAnimationFrame(r));
    }
    function delay(ms) {
      return new Promise(r => setTimeout(r, ms));
    }
    async function waitFor(condition, timeout = TAB_GRACE_WINDOW_MS) {
      const start = performance.now();
      while (!condition()) {
        await nextFrame();
        if (performance.now() - start > timeout) {
          throw new Error("timeout waiting for condition");
        }
      }
    }

    // Pretend we're in a Spotlight dialog so the effect runs
    const root = document.body.appendChild(document.createElement("div"));
    root.id = "multi-stage-message-root";
    root.className = "onboardingContainer";
    root.dataset.page = "spotlight";

    const mountNode = document.body.appendChild(document.createElement("div"));

    const content = {
      tiles: [{ type: "multiselect", header: { title: "Test" }, data: [] }],
    };

    const focusWrapper = mount(
      <main role="alertdialog">
        <ContentTiles
          content={content}
          handleAction={() => {}}
          activeMultiSelect={null}
          setActiveMultiSelect={() => {}}
        />
        <div className="action-buttons">
          <button className="primary">Continue</button>
        </div>
      </main>,
      { attachTo: mountNode }
    );

    // Let the hook attach listeners
    await nextFrame();

    const dialog = focusWrapper.getDOMNode();
    const header = dialog.querySelector(".tile-header");
    const primary = dialog.querySelector(".action-buttons .primary");

    // Record real DOM focus inside tiles
    header.focus();
    header.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await nextFrame();

    // Wait past the tab grace window so this isn’t treated as a real Tab
    await delay(TAB_GRACE_WINDOW_MS + 1);

    // Simulate programmatic focus “snap” to an outside control
    primary.focus();
    primary.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    await waitFor(() => document.activeElement === header);
    assert.strictEqual(
      document.activeElement,
      header,
      "restored focus to tiles header"
    );

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      })
    );
    primary.focus();
    primary.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await nextFrame();
    assert.strictEqual(
      document.activeElement,
      primary,
      "did not override genuine Tab focus"
    );

    // Slow tab (>250ms) to action buttons - focus should stay on button
    header.focus();
    header.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await nextFrame();

    // Wait past grace window to simulate slow tabbing
    await delay(TAB_GRACE_WINDOW_MS + 50);

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true })
    );
    primary.focus();
    primary.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    assert.strictEqual(
      document.activeElement,
      primary,
      "did not restore focus when slow tabbing to action buttons"
    );

    // Cleanup
    focusWrapper.unmount();
    mountNode.remove();
    root.remove();
  });

  it("passes content.skip_button to EmbeddedBackupRestore as skipButton", () => {
    const content = {
      tiles: [EMBEDDED_BACKUP_RESTORE_TILE],
      skip_button: {
        label: { raw: "Don't restore" },
        action: { navigate: true },
      },
    };

    const mountedWrapper = mount(
      <ContentTiles
        content={content}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const embeddedBackupComponent = mountedWrapper.find(EmbeddedBackupRestore);
    assert.ok(
      embeddedBackupComponent.exists(),
      "EmbeddedBackupRestore rendered"
    );
    assert.deepEqual(
      embeddedBackupComponent.prop("skipButton"),
      content.skip_button,
      "prop is wired"
    );
    mountedWrapper.unmount();
  });

  it("renders a single tile without container when there is no header or container style", () => {
    const SINGLE_TILE_NO_CONTAINER = {
      tiles: {
        tile_items: {
          type: "mobile_downloads",
          data: { email: { link_text: "Email!" } },
        },
        container: {},
      },
    };

    const mounted = mount(
      <ContentTiles
        content={SINGLE_TILE_NO_CONTAINER}
        handleAction={() => {}}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    assert.isFalse(
      mounted.find("#content-tiles-container").exists(),
      "should not render container wrapper"
    );
    assert.equal(mounted.find(".content-tile").length, 1);

    mounted.unmount();
  });

  it("passes migration_wizard_options properties to migration-wizard element", () => {
    const MIGRATION_WIZARD_TILE = {
      type: "migration-wizard",
      migration_wizard_options: {
        force_show_import_all: true,
        option_expander_title_string: "Custom title",
        hide_option_expander_subtitle: true,
        hide_select_all: true,
      },
    };

    const content = {
      tiles: [MIGRATION_WIZARD_TILE],
    };

    const mountedWrapper = mount(
      <ContentTiles
        content={content}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const embeddedMigrationWizard = mountedWrapper.find(
      EmbeddedMigrationWizard
    );
    assert.ok(
      embeddedMigrationWizard.exists(),
      "EmbeddedMigrationWizard rendered"
    );

    const migrationWizardEl = mountedWrapper.find("migration-wizard");
    assert.ok(migrationWizardEl.exists(), "migration-wizard element rendered");

    assert.equal(
      migrationWizardEl.prop("force-show-import-all"),
      true,
      "force-show-import-all is set"
    );
    assert.equal(
      migrationWizardEl.prop("option-expander-title-string"),
      "Custom title",
      "option-expander-title-string is set"
    );
    assert.equal(
      migrationWizardEl.prop("hide-option-expander-subtitle"),
      true,
      "hide-option-expander-subtitle is set"
    );
    assert.equal(
      migrationWizardEl.prop("hide-select-all"),
      true,
      "hide-select-all is set"
    );

    mountedWrapper.unmount();
  });

  it("does not override migration wizard defaults with missing options", () => {
    const mountedWrapper = mount(
      <ContentTiles
        content={{ tiles: [{ type: "migration-wizard" }] }}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    assert.isFalse(
      mountedWrapper
        .find("migration-wizard")
        .getDOMNode()
        .hasAttribute("option-expander-title-string"),
      "option-expander-title-string is omitted"
    );

    mountedWrapper.unmount();
  });

  it("should render link tiles with external-link-icon and no aria-expanded", () => {
    const LINK_TILE = {
      type: "link",
      header: {
        title: "link title",
      },
      action: {
        type: "OPEN_URL",
        data: { url: "https://example.com" },
      },
    };

    const linkWrapper = mount(
      <ContentTiles
        content={{ tiles: [LINK_TILE] }}
        handleAction={handleAction}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const tileButton = linkWrapper.find(".tile-header");

    assert.strictEqual(
      tileButton.prop("aria-expanded"),
      undefined,
      "Should not have aria-expanded since links don't expand content"
    );

    assert.strictEqual(
      tileButton.prop("aria-controls"),
      undefined,
      "Should not have aria-controls"
    );

    assert.ok(
      linkWrapper.find(".external-link-icon").exists(),
      "Should show external-link-icon"
    );
    assert.ok(
      !linkWrapper.find(".arrow-icon").exists(),
      "Should not show arrow-icon"
    );

    linkWrapper.unmount();
  });

  it("should call handleAction when link tile is clicked", () => {
    const LINK_TILE = {
      type: "link",
      id: "test-link",
      header: {
        title: "link tile",
      },
      action: {
        type: "OPEN_URL",
        data: { url: "https://example.com" },
      },
    };

    let telemetrySpy = sandbox.spy(MultiStageUtils, "sendActionTelemetry");
    const linkWrapper = mount(
      <ContentTiles
        content={{ tiles: [LINK_TILE] }}
        handleAction={handleAction}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );

    const tileButton = linkWrapper.find(".tile-header");
    tileButton.simulate("click");

    sinon.assert.calledOnce(handleAction);
    const callArgs = handleAction.firstCall.args;
    assert.equal(
      callArgs[1].type,
      "OPEN_URL",
      "Should call handleAction with tile action"
    );

    sinon.assert.calledOnce(telemetrySpy);
    assert.equal(
      telemetrySpy.firstCall.args[1],
      "link_test-link_header",
      "Telemetry should be sent for link tile click"
    );

    assert.ok(
      !linkWrapper.find(".tile-content").exists(),
      "Link tiles should not render tile-content"
    );

    linkWrapper.unmount();
  });

  it("should render TextBoxTile for 'textbox' tile type", () => {
    const TEXTBOX_TILE = {
      type: "textbox",
      header: { title: "Preview report" },
      data: {
        id: "chat-log-preview",
        content: '{"log":[]}',
        alternateContent: '{"log":[]}',
        label: "Include page content",
        rows: 8,
      },
    };
    const textboxWrapper = shallow(
      <ContentTiles
        content={{ tiles: [TEXTBOX_TILE] }}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
      />
    );
    textboxWrapper.find(".tile-header").simulate("click");
    assert.ok(textboxWrapper.find(TextBoxTile).exists());
  });

  it("should render ContentToggle for 'content-toggle' tile type", () => {
    const TOGGLE_TILE = {
      type: "content-toggle",
      data: {
        id: "page-content-toggle",
        label: "Include page content",
        visible: true,
      },
    };
    const setContentToggleChecked = sandbox.stub();
    const toggleWrapper = shallow(
      <ContentTiles
        content={{ tiles: [TOGGLE_TILE] }}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        contentToggleChecked={true}
        setContentToggleChecked={setContentToggleChecked}
      />
    );
    assert.ok(toggleWrapper.find(ContentToggle).exists());
    assert.equal(toggleWrapper.find(ContentToggle).prop("toggled"), true);
    assert.equal(
      toggleWrapper.find(ContentToggle).prop("onToggle"),
      setContentToggleChecked
    );
  });

  it("should pass contentToggleChecked to TextBoxTile", () => {
    const TEXTBOX_TILE = {
      type: "textbox",
      data: { id: "chat-log-preview", content: '{"log":[]}' },
    };
    const textboxWrapper = shallow(
      <ContentTiles
        content={{ tiles: [TEXTBOX_TILE] }}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        contentToggleChecked={false}
      />
    );
    assert.equal(
      textboxWrapper.find(TextBoxTile).prop("contentToggled"),
      false
    );
  });

  it("should use alternateTitle for textbox header when contentToggleChecked is false", () => {
    const TEXTBOX_TILE = {
      type: "textbox",
      header: {
        title: { string_id: "view-chat-details" },
        alternateTitle: { string_id: "view-chat-details-no-page" },
      },
      data: { id: "chat-log-preview", content: '{"log":[]}' },
    };
    const textboxWrapper = shallow(
      <ContentTiles
        content={{ tiles: [TEXTBOX_TILE] }}
        handleAction={handleAction}
        activeMultiSelect={null}
        setActiveMultiSelect={setActiveMultiSelect}
        contentToggleChecked={false}
      />
    );
    // When contentToggleChecked is false the alternateTitle should be used
    assert.deepEqual(
      textboxWrapper.find(".tile-header").find("Localized").at(0).prop("text"),
      TEXTBOX_TILE.header.alternateTitle
    );
  });
});
