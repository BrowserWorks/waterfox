const { StoreHandler } = ChromeUtils.importESModule(
  "resource:///modules/StoreHandler.sys.mjs"
);

this.total = class extends ExtensionAPI {
  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;

    return {
      wf: {
        onCrxInstall: new EventManager({
          context,
          name: "wf.onCrxInstall",
          register: (fire) => {
            const observer = (_subject, _topic, data) => {
              fire.sync(data);
            };
            Services.obs.addObserver(observer, "waterfox-test-stores");
            return () => {
              Services.obs.removeObserver(observer, "waterfox-test-stores");
            };
          },
        }).api(),

        attemptInstallChromeExtension(uri) {
          try {
            new StoreHandler().attemptInstall({ spec: uri });
          } catch (ex) {
            console.error(ex);
          }
        },
      },
    };
  }
};
