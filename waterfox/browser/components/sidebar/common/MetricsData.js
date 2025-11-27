/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

export default class MetricsData {
  constructor(name) {
    this.mItems = [];
    this.mName = name || '';

    const now = Date.now();
    this.mInitialTime = now;
    this.mLastTime    = now;
    this.mDeltaBetweenLastItem = 0;
  }

  add(label) {
    const now = Date.now();
    this.mItems.push({
      label: label,
      delta: now - this.mLastTime
    });
    this.mDeltaBetweenLastItem = now - this.mInitialTime;
    this.mLastTime = now;
  }

  addAsync(label, asyncTask) {
    const start = Date.now();
    if (typeof asyncTask == 'function')
      asyncTask = asyncTask();
    return asyncTask.then(result => {
      this.mItems.push({
        label: `(async) ${label}`,
        delta: Date.now() - start,
        async: true
      });
      return result;
    });
  }

  toString() {
    const logs = this.mItems.map(item => `${item.delta || 0}: ${item.label}`);
    return `${this.mName ? this.mName + ': ' : ''}total ${this.mDeltaBetweenLastItem} msec\n${logs.join('\n')}`;
  }

  static add(label) {
    return MetricsData.$static.add(label);
  }

  static addAsync(label, asyncTask) {
    return MetricsData.$static.addAsync(label, asyncTask);
  }

  static toString() {
    return MetricsData.$static.toString();
  }
}

MetricsData.$static = new MetricsData();
