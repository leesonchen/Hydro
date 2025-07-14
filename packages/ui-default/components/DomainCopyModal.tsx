import { NamedPage } from 'vj/misc/Page';
import { request, i18n } from 'vj/utils';
import Notification from 'vj/components/notification';
import DOMAttachedObject from 'vj/components/DOMAttachedObject';

interface CopyProgress {
  current: number;
  total: number;
  stage: string;
  detail?: string;
}

interface CopyResult {
  success: boolean;
  error?: string;
  summary?: {
    domain: boolean;
    problems: number;
    contests: number;
    trainings: number;
    users: number;
    groups: number;
    discussions: number;
    problemSolutions: number;
  };
}

export default class DomainCopyModal extends DOMAttachedObject {
  static DOMAttachKey = 'domainCopyModal';

  private $modal: JQuery;
  private $form: JQuery;
  private $progressContainer: JQuery;
  private $resultContainer: JQuery;
  private $progressBar: JQuery;
  private $progressText: JQuery;
  private $progressStage: JQuery;
  private $progressDetail: JQuery;
  private ws: WebSocket | null = null;

  constructor($dom: JQuery) {
    super($dom);
    this.init();
  }

  init() {
    this.$modal = this.$dom.find('#domain-copy-modal');
    this.$form = this.$dom.find('#domain-copy-form');
    this.$progressContainer = this.$dom.find('#progress-container');
    this.$resultContainer = this.$dom.find('#result-container');
    this.$progressBar = this.$dom.find('.progress-fill');
    this.$progressText = this.$dom.find('#progress-text');
    this.$progressStage = this.$dom.find('#progress-stage');
    this.$progressDetail = this.$dom.find('#progress-detail');

    this.bindEvents();
  }

  bindEvents() {
    // Domain ID validation
    let validationTimeout: number;
    this.$form.find('input[name="targetDomainId"]').on('input', (e) => {
      const domainId = $(e.target).val() as string;
      const $messageEl = $(e.target).siblings('.validation-message');
      
      if (!domainId.trim()) {
        $messageEl.removeClass('success error').text('');
        return;
      }
      
      clearTimeout(validationTimeout);
      validationTimeout = window.setTimeout(async () => {
        try {
          const response = await request.get('/domain/copy/validate', { domainId });
          if (response.available) {
            $messageEl.removeClass('error').addClass('success')
              .text(i18n('Domain ID is available'));
          } else {
            $messageEl.removeClass('success').addClass('error')
              .text(i18n('Domain ID already exists'));
          }
        } catch {
          $messageEl.removeClass('success').addClass('error')
            .text(i18n('Failed to validate domain ID'));
        }
      }, 500);
    });

    // Problem mapping management
    this.$dom.find('#add-mapping').on('click', () => {
      const $template = this.$dom.find('.problem-mapping-row.template').clone();
      $template.removeClass('template').show();
      this.$dom.find('#problem-mapping').append($template);
    });

    this.$dom.on('click', '.remove-mapping', (e) => {
      $(e.target).closest('.problem-mapping-row').remove();
    });

    // Form submission
    this.$form.on('submit', (e) => {
      e.preventDefault();
      this.handleFormSubmit();
    });

    // Modal events
    this.$modal.on('close.zf.reveal', () => {
      this.cleanup();
    });
  }

  async handleFormSubmit() {
    // Validate form
    const sourceDomainId = this.$form.find('select[name="sourceDomainId"]').val() as string;
    const targetDomainId = this.$form.find('input[name="targetDomainId"]').val() as string;
    const targetDomainName = this.$form.find('input[name="targetDomainName"]').val() as string;
    
    if (!sourceDomainId || !targetDomainId || !targetDomainName) {
      // Show error toast
      Notification.error(i18n('Please fill in all required fields'));
      return;
    }
    
    // Check domain availability
    const $messageEl = this.$form.find('input[name="targetDomainId"]').siblings('.validation-message');
    if ($messageEl.hasClass('error')) {
      Notification.error(i18n('Target domain ID is not available'));
      return;
    }

    // Prepare form data
    const formData = this.collectFormData();
    
    // Show progress
    this.showProgress();
    
    // Start copy process
    await this.startDomainCopy(formData);
  }

  collectFormData() {
    const formData = new FormData();
    
    // Basic fields
    formData.append('sourceDomainId', this.$form.find('select[name="sourceDomainId"]').val() as string);
    formData.append('targetDomainId', this.$form.find('input[name="targetDomainId"]').val() as string);
    formData.append('targetDomainName', this.$form.find('input[name="targetDomainName"]').val() as string);
    
    // Options
    const options = [
      'copyProblems', 'copyContests', 'copyTrainings', 
      'copyUsers', 'copyGroups', 'copyDiscussions', 
      'copyProblemSolutions', 'preserveIds'
    ];
    
    for (const option of options) {
      const checked = this.$form.find(`input[name="${option}"]`).is(':checked');
      formData.append(option, checked.toString());
    }
    
    // Problem mappings
    const nameMapping: Record<string, string> = {};
    this.$dom.find('.problem-mapping-row:not(.template)').each((_, row) => {
      const $row = $(row);
      const source = $row.find('input[name="sourceProblems[]"]').val() as string;
      const target = $row.find('input[name="targetProblems[]"]').val() as string;
      if (source?.trim() && target?.trim()) {
        nameMapping[source.trim()] = target.trim();
      }
    });
    formData.append('nameMapping', JSON.stringify(nameMapping));
    
    return formData;
  }

  showProgress() {
    this.$progressContainer.show();
    this.$resultContainer.hide();
    this.updateProgress({ current: 0, total: 1, stage: i18n('Initializing...') });
  }

  updateProgress(progress: CopyProgress) {
    const percentage = progress.total > 0 ? (progress.current / progress.total * 100) : 0;
    this.$progressBar.css('width', `${percentage}%`);
    this.$progressStage.text(progress.stage);
    this.$progressDetail.text(progress.detail || '');
    this.$progressText.text(`${progress.current} / ${progress.total}`);
  }

  async startDomainCopy(formData: FormData) {
    // Connect to WebSocket for progress updates
    try {
      this.connectWebSocket();
      
      // Submit form
      const response = await request.postFile('/domain/copy', formData) as CopyResult;
      this.showResult(response);
    } catch (error) {
      this.showResult({
        success: false,
        error: error.message || i18n('Unknown error occurred')
      });
    } finally {
      this.disconnectWebSocket();
    }
  }

  connectWebSocket() {
    if (this.ws) return;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'progress') {
        this.updateProgress(data.payload);
      }
    };
    
    this.ws.onerror = (error) => {
      console.warn('WebSocket error:', error);
    };
  }

  disconnectWebSocket() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  showResult(response: CopyResult) {
    this.$progressContainer.hide();
    this.$resultContainer.show();
    
    if (response.success) {
      this.$resultContainer.find('#success-result').show();
      this.$resultContainer.find('#error-result').hide();
      
      // Show summary
      if (response.summary) {
        const summary = response.summary;
        let summaryHtml = '<ul>';
        if (summary.domain) summaryHtml += `<li>${i18n('Domain created successfully')}</li>`;
        if (summary.problems > 0) summaryHtml += `<li>${i18n('Problems copied')}: ${summary.problems}</li>`;
        if (summary.contests > 0) summaryHtml += `<li>${i18n('Contests copied')}: ${summary.contests}</li>`;
        if (summary.trainings > 0) summaryHtml += `<li>${i18n('Trainings copied')}: ${summary.trainings}</li>`;
        if (summary.users > 0) summaryHtml += `<li>${i18n('Users copied')}: ${summary.users}</li>`;
        if (summary.groups > 0) summaryHtml += `<li>${i18n('Groups copied')}: ${summary.groups}</li>`;
        if (summary.discussions > 0) summaryHtml += `<li>${i18n('Discussions copied')}: ${summary.discussions}</li>`;
        if (summary.problemSolutions > 0) summaryHtml += `<li>${i18n('Problem solutions copied')}: ${summary.problemSolutions}</li>`;
        summaryHtml += '</ul>';
        
        this.$resultContainer.find('#copy-summary').html(summaryHtml);
      }
      
      // Show success toast
      Notification.success(i18n('Domain copied successfully'));
    } else {
      this.$resultContainer.find('#success-result').hide();
      this.$resultContainer.find('#error-result').show();
      this.$resultContainer.find('#error-message').text(response.error || i18n('Unknown error'));
      
      // Show error toast
      Notification.error(response.error || i18n('Domain copy failed'));
    }
  }

  cleanup() {
    this.disconnectWebSocket();
    
    // Reset form
    (this.$form[0] as HTMLFormElement).reset();
    this.$dom.find('.validation-message').removeClass('success error').text('');
    this.$dom.find('.problem-mapping-row:not(.template)').remove();
    
    // Reset progress
    this.$progressContainer.hide();
    this.$resultContainer.hide();
    this.updateProgress({ current: 0, total: 1, stage: '' });
  }

  static initAll() {
    $('[data-domain-copy-modal]').each((i, dom) => {
      DomainCopyModal.getOrConstruct($(dom));
    });
  }
}

// Auto-initialize when DOM is ready
$(() => {
  DomainCopyModal.initAll();
});

// Register page if used as standalone page
const page = new NamedPage('domain_copy', () => {
  DomainCopyModal.initAll();
});

export { page };