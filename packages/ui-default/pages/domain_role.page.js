import $ from 'jquery';
import _ from 'lodash';
import { ActionDialog, ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import {
  delay, i18n, request, tpl,
} from 'vj/utils';

const page = new NamedPage('domain_role', () => {
  const createRoleDialog = new ActionDialog({
    $body: $('.dialog__body--create-role > div'),
    onDispatch(action) {
      const $role = createRoleDialog.$dom.find('[name="role"]');
      if (action === 'ok' && $role.val() === '') {
        $role.focus();
        return false;
      }
      return true;
    },
  });
  createRoleDialog.clear = function () {
    this.$dom.find('[name="role"]').val('');
    return this;
  };

  function ensureAndGetSelectedRoles() {
    const roles = _.map(
      $('.domain-roles tbody [data-checkbox-group="role"]:checked'),
      (ch) => $(ch).closest('tr').attr('data-role'),
    );
    if (roles.length === 0) {
      Notification.error(i18n('Please select at least one role to perform this operation.'));
      return null;
    }
    return roles;
  }

  async function handleClickCreateRole() {
    const action = await createRoleDialog.clear().open();
    if (action !== 'ok') return;
    const role = createRoleDialog.$dom.find('[name="role"]').val();
    try {
      await request.post('', {
        operation: 'add',
        role,
      });
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  }

  async function handleClickDeleteSelected() {
    const selectedRoles = ensureAndGetSelectedRoles();
    if (selectedRoles === null) return;
    const action = await new ConfirmDialog({
      $body: tpl`
        <div class="typo">
          <p>${i18n('Confirm deleting the selected roles?')}</p>
          <p>${i18n('Users with those roles will be removed from the domain.')}</p>
        </div>`,
    }).open();
    if (action !== 'yes') return;
    try {
      await request.post('', {
        operation: 'delete',
        roles: selectedRoles,
      });
      Notification.success(i18n('Selected roles have been deleted.'));
      await delay(2000);
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  }

  async function handleClickUpdateRoles() {
    const roles = _.map($('.domain-roles tbody tr'), (row) => {
      const $row = $(row);
      const $default = $row.find('[data-role-default]');
      const $priority = $row.find('[data-role-priority]');
      return {
        role: $default.attr('data-role-default'),
        default: $default.prop('checked') === true,
        priority: Number($priority.is('input') ? $priority.val() : $priority.attr('data-priority')),
      };
    });
    if (roles.filter((role) => role.default).length !== 1) {
      Notification.error(i18n('Select exactly one default invitation role.'));
      return;
    }
    if (roles.some((role) => !Number.isInteger(role.priority) || role.priority < 0 || role.priority >= roles.length)
      || new Set(roles.map((role) => role.priority)).size !== roles.length) {
      Notification.error(i18n('Role priorities must be unique positions in the role order.'));
      return;
    }
    try {
      await request.post('', { operation: 'update', roles });
      Notification.success(i18n('Role settings have been updated.'));
      await delay(1000);
      window.location.reload();
    } catch (error) {
      Notification.error(error.message);
    }
  }

  $('[name="create_role"]').on('click', () => handleClickCreateRole());
  $('[name="update_roles"]').on('click', () => handleClickUpdateRoles());
  $('[name="delete_selected"]').on('click', () => handleClickDeleteSelected());
  $('.domain-roles input[data-role-priority]').on('change', (ev) => {
    const $input = $(ev.currentTarget);
    const $row = $input.closest('tr');
    const $otherRows = $row.siblings();
    const priority = Number($input.val());
    if (!Number.isInteger(priority) || priority < 1 || priority >= $otherRows.length) {
      $input.val($row.index());
      Notification.error(i18n('Role priorities must be unique positions in the role order.'));
      return;
    }
    $row.insertBefore($otherRows.eq(priority));
    $('.domain-roles tbody tr').each((index, row) => {
      $(row).find('input[data-role-priority]').val(index);
    });
  });
});

export default page;
