-- =============================================================================
-- Python Integration (uv & Poetry)
-- =============================================================================

return {
  -- Enhanced Python support with uv and Poetry integration
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        -- Pyright configuration for uv and Poetry environments
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
      -- Automatically detect uv and Poetry virtual environments
      anaconda_base_path = nil,
      anaconda_envs_path = nil,
      pyenv_path = vim.fn.expand("~/.pyenv/versions"),
      pipenv_path = nil,
      poetry_path = vim.fn.expand("~/Library/Caches/pypoetry/virtualenvs"),
      hatch_path = nil,
      venvwrapper_path = nil,

      -- Add uv and Poetry venv detection
      name = {
        ".venv",
        "venv",
      },

      -- Enable environment detection
      enable_cached_venvs = true,
      cached_venv_automatic_activation = true,

      -- Search in parent directories for .venv and pyproject.toml
      parents = 3,

      -- uv creates .venv by default, Poetry uses cache directory
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
      -- Auto-detect uv and Poetry virtual environments
      local util = require("lspconfig.util")

      -- Function to find uv venv
      local function get_uv_venv_path(root_dir)
        local venv_path = util.path.join(root_dir, ".venv")
        if vim.fn.isdirectory(venv_path) == 1 then
          return venv_path
        end
        return nil
      end

      -- Function to find Poetry venv
      local function get_poetry_venv_path(root_dir)
        -- Check if pyproject.toml exists and contains poetry
        local pyproject_path = util.path.join(root_dir, "pyproject.toml")
        if vim.fn.filereadable(pyproject_path) == 1 then
          local pyproject_content = vim.fn.readfile(pyproject_path)
          local is_poetry_project = false
          for _, line in ipairs(pyproject_content) do
            if line:match("tool%.poetry") then
              is_poetry_project = true
              break
            end
          end

          if is_poetry_project then
            -- Try to get Poetry env path
            local handle = io.popen("cd '" .. root_dir .. "' && poetry env info --path 2>/dev/null")
            if handle then
              local result = handle:read("*a")
              handle:close()
              local venv_path = result:gsub("^%s+", ""):gsub("%s+$", "")
              if venv_path ~= "" and vim.fn.isdirectory(venv_path) == 1 then
                return venv_path
              end
            end
          end
        end
        return nil
      end

      -- Override python path detection
      opts.servers = vim.tbl_deep_extend("force", opts.servers or {}, {
        pyright = {
          before_init = function(_, config)
            local root_dir = config.root_dir
            -- Try uv first, then Poetry
            local venv = get_uv_venv_path(root_dir) or get_poetry_venv_path(root_dir)

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
            -- Check if it's a Poetry environment
            if venv:match("pypoetry/virtualenvs") then
              return "  (poetry) " .. venv_name
            else
              return "  " .. venv_name
            end
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

