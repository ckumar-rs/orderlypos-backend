import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import {
  menuCategorySchema,
  menuItemSchema,
  menuPriceRuleSchema,
  menuSetSchema,
  modifierGroupSchema,
  modifierImageSchema,
  kitchenCourseSchema,
  kitchenStationSchema,
  menuItemChannelPricesSchema,
  salesChannelSchema,
  setComboComponentsSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import {
  assertValidImageSignature,
  imageUploadOptions,
} from '../../common/upload/image-upload.config';
import { MenuService } from './menu.service';

@ApiTags('menu')
@Controller('v1/menu')
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  // --- Categories ---------------------------------------------------------

  @Auth('menu.view')
  @Get('categories')
  async listCategories(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listCategories(branchId);
  }

  @Auth('menu.manage')
  @Post('categories')
  @UsePipes(new ZodValidationPipe(menuCategorySchema))
  async createCategory(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createCategory(branchId, body as never);
  }

  @Auth('menu.manage')
  @Patch('categories/:id')
  async updateCategory(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateCategory(branchId, id, body as never);
  }

  @Auth('menu.manage')
  @Delete('categories/:id')
  async deleteCategory(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteCategory(branchId, id);
  }

  // --- Kitchen stations -----------------------------------------------------

  @Auth('menu.manage')
  @Get('stations')
  async listStations(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listStations(branchId);
  }

  @Auth('menu.manage')
  @Post('stations')
  @UsePipes(new ZodValidationPipe(kitchenStationSchema))
  async createStation(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { name: string; printerName?: string; role?: string },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createStation(
      branchId,
      body.name,
      body.printerName,
      body.role,
    );
  }

  @Auth('menu.manage')
  @Get('courses')
  async listCourses(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listCourses(branchId);
  }

  @Auth('menu.manage')
  @Post('courses')
  @UsePipes(new ZodValidationPipe(kitchenCourseSchema))
  async createCourse(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createCourse(branchId, body as never);
  }

  @Auth('menu.manage')
  @Delete('courses/:id')
  async deleteCourse(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteCourse(branchId, id);
  }

  // --- Menu items -----------------------------------------------------------

  @Auth('menu.view')
  @Get('items')
  async listItems(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('categoryId') categoryId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listItems(branchId, categoryId);
  }

  @Auth('menu.view')
  @Get('items/:id')
  async getItem(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.getItem(branchId, id);
  }

  @Auth('menu.manage')
  @Post('items')
  @UsePipes(new ZodValidationPipe(menuItemSchema))
  async createItem(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createItem(branchId, body as never, user.id);
  }

  @Auth('menu.manage')
  @Post('items/upload-image')
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  uploadItemImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    // fileFilter (imageUploadOptions) only saw the client-declared
    // filename/mimetype before any bytes were read — verify the bytes
    // actually on disk match a real image signature before this URL is
    // ever handed back to be saved on a menu item and served publicly.
    assertValidImageSignature(file.path);
    return { url: `/api/uploads/${file.filename}` };
  }

  @Auth('menu.manage')
  @Patch('items/:id')
  async updateItem(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateItem(branchId, id, user.id, body as never);
  }

  @Auth('menu.manage')
  @Delete('items/:id')
  async deleteItem(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteItem(branchId, id);
  }

  // --- Modifier groups --------------------------------------------------------

  @Auth('menu.manage')
  @Get('modifier-groups')
  async listModifierGroups(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listModifierGroups(branchId);
  }

  @Auth('menu.manage')
  @Post('modifier-groups')
  @UsePipes(new ZodValidationPipe(modifierGroupSchema))
  async createModifierGroup(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createModifierGroup(branchId, body as never);
  }

  @Auth('menu.manage')
  @Patch('modifier-groups/:id')
  async updateModifierGroup(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateModifierGroup(branchId, id, body as never);
  }

  @Auth('menu.manage')
  @Patch('modifiers/:id')
  @UsePipes(new ZodValidationPipe(modifierImageSchema))
  async updateModifierImage(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateModifierImage(
      branchId,
      id,
      (body as { imageUrl: string | null }).imageUrl,
    );
  }

  @Auth('menu.manage')
  @Delete('modifier-groups/:id')
  async deleteModifierGroup(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteModifierGroup(branchId, id);
  }

  @Auth('menu.manage')
  @Post('items/:id/channel-prices')
  @UsePipes(new ZodValidationPipe(menuItemChannelPricesSchema))
  async setItemChannelPrices(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const { prices } = body as { prices: { channelId: string; price: number }[] };
    return this.menuService.setItemChannelPrices(branchId, id, prices, user.id);
  }

  @Auth('menu.view')
  @Get('channels')
  async listChannels(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listChannels(branchId);
  }

  @Auth('menu.manage')
  @Post('channels')
  @UsePipes(new ZodValidationPipe(salesChannelSchema))
  async createChannel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createChannel(branchId, body as never);
  }

  @Auth('menu.manage')
  @Patch('channels/:id')
  async updateChannel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateChannel(branchId, id, body as never);
  }

  @Auth('menu.manage')
  @Delete('channels/:id')
  async deleteChannel(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteChannel(branchId, id);
  }

  @Auth('menu.view')
  @Get('sets')
  async listSets(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listSets(branchId);
  }

  @Auth('menu.manage')
  @Post('sets')
  @UsePipes(new ZodValidationPipe(menuSetSchema))
  async createSet(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createSet(branchId, body as never);
  }

  @Auth('menu.manage')
  @Patch('sets/:id')
  async updateSet(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.updateSet(branchId, id, body as never);
  }

  @Auth('menu.manage')
  @Delete('sets/:id')
  async deleteSet(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deleteSet(branchId, id);
  }

  @Auth('menu.view')
  @Get('price-rules')
  async listPriceRules(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.listPriceRules(branchId);
  }

  @Auth('menu.manage')
  @Post('price-rules')
  @UsePipes(new ZodValidationPipe(menuPriceRuleSchema))
  async createPriceRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.createPriceRule(branchId, body as never, user.id);
  }

  @Auth('menu.manage')
  @Patch('price-rules/:id')
  async setPriceRuleActive(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: { isActive?: boolean },
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.setPriceRuleActive(branchId, id, Boolean(body.isActive), user.id);
  }

  @Auth('menu.manage')
  @Delete('price-rules/:id')
  async deletePriceRule(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.deletePriceRule(branchId, id, user.id);
  }

  // --- Combo meals -----------------------------------------------------------

  @Auth('menu.manage')
  @Get('items/:id/combo-components')
  async getComboComponents(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.menuService.getComboComponents(branchId, id);
  }

  @Auth('menu.manage')
  @Post('items/:id/combo-components')
  @UsePipes(new ZodValidationPipe(setComboComponentsSchema))
  async setComboComponents(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const { components } = body as {
      components: { componentItemId: string; quantity: number }[];
    };
    return this.menuService.setComboComponents(branchId, id, components);
  }
}
