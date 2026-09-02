/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// This file is loaded into the same context as subprocess_unix.worker.js
// and subprocess_win.worker.js
/* import-globals-from subprocess_unix.worker.js */

/* exported BasePipe, BaseProcess, debug */

function debug(message) {
  self.postMessage({ msg: "debug", message });
}

class BasePipe {
  constructor() {
    this.closing = false;
    this.closed = false;

    this.closedPromise = new Promise(resolve => {
      this.resolveClosed = resolve;
    });

    this.pending = [];
  }

  shiftPending() {
    let result = this.pending.shift();

    if (this.closing && !this.pending.length) {
      this.close();
    }

    return result;
  }
}

let nextProcessId = 0;

class BaseProcess {
  constructor(options) {
    this.id = nextProcessId++;

    this.exitCode = null;

    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve;
    });
    this.exitPromise.then(() => {
      // The input file descriptors will be closed after poll
      // reports that their input buffers are empty. If we close
      // them now, we may lose output.
      this.pipes[0].close(true);
    });

    this.pid = null;
    this.pipes = [];

    this.spawn(options);
  }

  /**
   * Waits for the process to exit and all of its pending IO operations to
   * complete.
   *
   * @returns {Promise<void>}
   */
  awaitFinished() {
    return Promise.all([
      this.exitPromise,
      ...this.pipes.map(pipe => pipe.closedPromise),
    ]);
  }
}

let requests = {
  init(details) {
    io.init(details);

    return { data: {} };
  },

  shutdown() {
    io.shutdown();

    return { data: {} };
  },

  close(pipeId, force = false) {
    let pipe = io.getPipe(pipeId);

    return pipe.close(force).then(() => ({ data: {} }));
  },

  spawn(options) {
    let process = new Process(options);
    let processId = process.id;

    io.addProcess(process);

    let fds = process.pipes.map(pipe => pipe.id);

    return { data: { processId, fds, pid: process.pid } };
  },

  connectRunning(options) {
    let process = new ManagedProcess(options);
    let processId = process.id;

    io.addProcess(process);

    return { data: { processId, fds: process.pipes.map(pipe => pipe.id) } };
  },

  kill(processId, force = false) {
    let process = io.getProcess(processId);

    process.kill(force ? 9 : 15);

    return { data: {} };
  },

  wait(processId) {
    let process = io.getProcess(processId);

    process.wait();

    process.awaitFinished().then(() => {
      io.cleanupProcess(process);
    });

    return process.exitPromise.then(exitCode => {
      return { data: { exitCode } };
    });
  },

  read(pipeId, count) {
    let pipe = io.getPipe(pipeId);

    return pipe.read(count).then(buffer => {
      return { data: { buffer } };
    });
  },

  write(pipeId, buffer) {
    let pipe = io.getPipe(pipeId);

    return pipe.write(buffer).then(bytesWritten => {
      return { data: { bytesWritten } };
    });
  },

  // For testing.
  getIsPolling() {
    return { data: io.polling };
  },

  // For testing.
  getOpenFiles() {
    return { data: new Set(io.pipes.keys()) };
  },

  // For testing.
  getProcesses() {
    let data = new Map(
      Array.from(io.processes.values())
        .filter(proc => proc.exitCode == null)
        .map(proc => [proc.id, proc.pid])
    );
    return { data };
  },

  // For testing.
  waitForNoProcesses() {
    return Promise.all(
      Array.from(io.processes.values(), proc => proc.awaitFinished())
    );
  },

  // It is the caller's responsibility to make sure dup() is called on the FDs
  // returned here.
  getFds(processId) {
    // fd is a unix.Fd aka CDataFinalizer that wraps the actual integer. We can
    // retrieve its value via .toString(), if it has not been closed yet.
    let process = io.getProcess(processId);
    let pipes = process.pipes.map(p => parseInt(p.fd.toString(), 10));
    return {
      data: [pipes[0], pipes[1], pipes[2]],
    };
  },
};

onmessage = event => {
  io.messageCount--;

  let { msg, msgId, args } = event.data;

  new Promise(resolve => {
    resolve(requests[msg](...args));
  })
    .then(result => {
      let response = {
        msg: "success",
        msgId,
        data: result.data,
      };

      self.postMessage(response, result.transfer || []);
    })
    .catch(error => {
      self.postMessage({
        msg: "failure",
        msgId,
        error,
        // We sometimes attach an extra property to the error, which is not
        // copied when the error passes through structuredClone.
        errorCode: error.errorCode,
      });
    })
    .catch(error => {
      console.error(error);

      self.postMessage({
        msg: "failure",
        msgId,
        error: {},
      });
    });
};
