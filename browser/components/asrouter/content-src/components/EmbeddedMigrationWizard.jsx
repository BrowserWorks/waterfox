/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useEffect, useRef } from "react";

/**
 * Embeds a migration wizard component within About:Welcome,
 * and passes configuration options from content to the migration-wizard element
 *
 * @param {function} handleAction - The action handler function that processes migration events
 * @param {object} content - The content object that contains tiles configuration
 * @param {object} content.tiles - The tiles configuration object
 * @param {object} content.tiles.migration_wizard_options - Configuration options for the migration wizard
 *   All options, including migration_wizard_options itself, are optional and have fallback values:
 *   - {boolean} force_show_import_all - Whether to force show import all option
 *   - {string} option_expander_title_string - Title string for the option expander
 *   - {boolean} hide_option_expander_subtitle - Whether or not to hide the option expander subtitle
 *   - {string} data_import_complete_success_string - Success message string after import completion
 *   - {string} migrator_key - The migrator key to select by default
 *   - {string} selection_header_string - Header string for the selection section
 *   - {string} selection_subheader_string - Subheader string for the selection section
 *   - {boolean} hide_select_all - Whether to hide the select all option
 *   - {string} checkbox_margin_inline - Inline margin for checkboxes
 *   - {string} checkbox_margin_block - Block margin for checkboxes
 *   - {string} import_button_string - Text string for the import button
 *   - {string} import_button_class - CSS class for the import button
 *   - {string} header_font_size - Font size for the header
 *   - {string} header_font_weight - Font weight for the header
 *   - {string} header_margin_block - Block margin for the header
 *   - {string} subheader_font_size - Font size for the subheader
 *   - {string} subheader_font_weight - Font weight for the subheader
 *   - {string} subheader_margin_block - Block margin for the subheader
 */
export const EmbeddedMigrationWizard = ({ handleAction, content }) => {
  const ref = useRef();
  const options = content.tiles?.migration_wizard_options;
  useEffect(() => {
    const handleBeginMigration = () => {
      handleAction({
        currentTarget: { value: "migrate_start" },
        source: "primary_button",
      });
    };
    const handleClose = () => {
      handleAction({ currentTarget: { value: "migrate_close" } });
    };
    const { current } = ref;
    current?.addEventListener(
      "MigrationWizard:BeginMigration",
      handleBeginMigration
    );
    current?.addEventListener("MigrationWizard:Close", handleClose);
    return () => {
      current?.removeEventListener(
        "MigrationWizard:BeginMigration",
        handleBeginMigration
      );
      current?.removeEventListener("MigrationWizard:Close", handleClose);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <migration-wizard
      in-aboutwelcome-bundle=""
      force-show-import-all={options?.force_show_import_all || "false"}
      auto-request-state=""
      ref={ref}
      option-expander-title-string={
        options?.option_expander_title_string ?? null
      }
      hide-option-expander-subtitle={
        options?.hide_option_expander_subtitle || false
      }
      data-import-complete-success-string={
        options?.data_import_complete_success_string || ""
      }
      migrator-key={options?.migrator_key || ""}
      selection-header-string={options?.selection_header_string || ""}
      selection-subheader-string={options?.selection_subheader_string || ""}
      hide-select-all={options?.hide_select_all || false}
      checkbox-margin-inline={options?.checkbox_margin_inline || ""}
      checkbox-margin-block={options?.checkbox_margin_block || ""}
      import-button-string={options?.import_button_string || ""}
      import-button-class={options?.import_button_class || ""}
      header-font-size={options?.header_font_size || ""}
      header-font-weight={options?.header_font_weight || ""}
      header-margin-block={options?.header_margin_block || ""}
      subheader-font-size={options?.subheader_font_size || ""}
      subheader-font-weight={options?.subheader_font_weight || ""}
      subheader-margin-block={options?.subheader_margin_block || ""}
    ></migration-wizard>
  );
};
