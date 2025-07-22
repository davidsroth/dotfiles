-- ============================================================================
-- Python & uv Integration
-- ============================================================================

return {
  -- Enhanced Python support with uv integration
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Pyright configuration for uv environments
        pyright = {
          settings = {
            python = {
              analysis = {
                autoSearchPaths = true,
                useLibraryCodeForTypes = true,
                diagnosticMode = "workspace",
              },
            },
          },
        },
        -- Alternative: basedpyright (fork of pyright with better type checking)
        -- basedpyright = {},
      },
    },
  },

  -- Python virtual environment selector
  {
    "linux-cultist/venv-selector.nvim",
    dependencies = {
      "neovim/nvim-lspconfig",
      "nvim-telescope/telescope.nvim",
      "mfussenegger/nvim-dap-python",
    },
    opts = {
      -- Automatically detect uv virtual environments
      anaconda_base_path = nil,
      anaconda_envs_path = nil,
      pyenv_path = vim.fn.expand("~/.pyenv/versions"),
      pipenv_path = nil,
      poetry_path = nil,
      hatch_path = nil,
      venvwrapper_path = nil,
      
      -- Add uv venv detection
      name = {
        ".venv",
        "venv",
      },
      
      -- Enable uv environment detection
      enable_cached_venvs = true,
      cached_venv_automatic_activation = true,
      
      -- Search in parent directories for .venv
      parents = 2,
      
      -- uv creates .venv by default
      dap_enabled = true,
    },
    keys = {
      { "<leader>cv", "<cmd>VenvSelect<cr>", desc = "Select VirtualEnv" },
      { "<leader>cV", "<cmd>VenvSelectCached<cr>", desc = "Select Cached VirtualEnv" },
    },
    cmd = { "VenvSelect", "VenvSelectCached" },
  },

  -- Automatically activate virtual environments
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "linux-cultist/venv-selector.nvim",
    },
    opts = function(_, opts)
      -- Auto-detect uv virtual environments
      local util = require("lspconfig.util")
      
      -- Function to find uv venv
      local function get_uv_venv_path(root_dir)
        local venv_path = util.path.join(root_dir, ".venv")
        if vim.fn.isdirectory(venv_path) == 1 then
          return venv_path
        end
        return nil
      end
      
      -- Override python path detection
      opts.servers = vim.tbl_deep_extend("force", opts.servers or {}, {
        pyright = {
          before_init = function(_, config)
            local root_dir = config.root_dir
            local venv = get_uv_venv_path(root_dir)
            
            if venv then
              config.settings.python.pythonPath = util.path.join(venv, "bin", "python")
              config.settings.python.venvPath = vim.fn.fnamemodify(venv, ":h")
              config.settings.python.venv = vim.fn.fnamemodify(venv, ":t")
            end
          end,
        },
      })
      
      return opts
    end,
  },

  -- Mason integration for Python tools
  {
    "williamboman/mason.nvim",
    opts = function(_, opts)
      opts.ensure_installed = opts.ensure_installed or {}
      vim.list_extend(opts.ensure_installed, {
        "pyright",
        "ruff",
        "ruff-lsp",
        "debugpy",
      })
    end,
  },

  -- Formatting with ruff (uv's preferred formatter)
  {
    "stevearc/conform.nvim",
    optional = true,
    opts = {
      formatters_by_ft = {
        python = { "ruff_format", "ruff_fix" },
      },
      formatters = {
        ruff_format = {
          command = "ruff",
          args = { "format", "--stdin-filename", "$FILENAME", "-" },
        },
        ruff_fix = {
          command = "ruff",
          args = { "check", "--fix", "--stdin-filename", "$FILENAME", "-" },
        },
      },
    },
  },

  -- Show virtual environment in statusline
  {
    "nvim-lualine/lualine.nvim",
    optional = true,
    event = "VeryLazy",
    opts = function(_, opts)
      table.insert(opts.sections.lualine_x, {
        function()
          local venv = vim.env.VIRTUAL_ENV
          if venv then
            local venv_name = vim.fn.fnamemodify(venv, ":t")
            return "  " .. venv_name
          end
          return ""
        end,
        cond = function()
          return vim.bo.filetype == "python"
        end,
      })
    end,
  },
}