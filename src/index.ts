/*
 * Copyright 2021 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

interface App {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any) => void
}

export default function (app: App): Plugin {
  const debug =
    app.debug ||
    ((msg: string) => {
      console.log(msg)
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start: function (props: any) {
      debug('start', props)
    },

    stop: function () {
      debug('stop')
    },

    started: false,
    id: 'tracks',
    name: 'Tracks',
    description: 'Accumulate in memory tracks and provide the track API',
    schema: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          title: 'Port',
          default: 12345,
        },
      },
    },
  }

  return plugin
}
