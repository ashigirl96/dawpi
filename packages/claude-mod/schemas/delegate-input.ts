// A hooks module imports only files inside the plugin, so this copies the contracts schema; a root test keeps the two equal.
export const DELEGATE_INPUT_SCHEMA = {
  "type": "object",
  "properties": {
    "task": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1
        },
        "prompt": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "prompt"
      ],
      "additionalProperties": false
    },
    "execution": {
      "type": "object",
      "properties": {
        "model": {
          "type": "string",
          "minLength": 1
        },
        "effort": {
          "type": "string",
          "minLength": 1,
          "not": {
            "enum": [
              "ultra"
            ]
          }
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "workspace": {
      "type": "object",
      "properties": {
        "directory": {
          "type": "string",
          "minLength": 1
        },
        "isolation": {
          "type": "string",
          "enum": [
            "shared-read",
            "isolated-write",
            "exclusive-write"
          ]
        }
      },
      "required": [
        "directory"
      ],
      "additionalProperties": false
    },
    "permissions": {
      "type": "object",
      "properties": {
        "sandbox": {
          "type": "string",
          "enum": [
            "read-only",
            "workspace-write"
          ]
        },
        "approvalPolicy": {
          "type": "string",
          "enum": [
            "untrusted",
            "on-request",
            "never"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "context": {
      "type": "object",
      "properties": {
        "artifacts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "contentHash": {
                "type": "string",
                "minLength": 1
              },
              "range": {
                "type": "object",
                "properties": {
                  "startLine": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "endLine": {
                    "type": "integer",
                    "minimum": 1
                  }
                },
                "required": [
                  "startLine",
                  "endLine"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "path"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "required": [
    "task"
  ],
  "additionalProperties": false
}

